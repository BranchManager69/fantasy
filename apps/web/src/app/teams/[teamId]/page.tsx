import clsx from "clsx";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import {
  formatMargin,
  formatOwners,
  probabilityLabel,
  probabilityTone,
} from "@/lib/formatters";
import { RefreshControls } from "@/components/refresh-controls";
import { ScenarioDrawer } from "@/components/scenario-drawer";
import { ScenarioSwitcher } from "@/components/scenario-switcher";
import { listScenarios } from "@/lib/scenario-data";
import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";
import {
  buildSimulationLookup,
  getLatestSimulation,
  getTeamContext,
  getTeamSchedule,
  type SimulationPlayer,
} from "@/lib/simulator-data";
import { normalizeScenarioId, type ScenarioSearchParam } from "@/lib/scenario-utils";
import { TeamTimeline } from "@/components/team-timeline";
import { MatchupCard } from "@/components/team/matchup-card";
import { TeamSummaryCard } from "@/components/team/team-summary-card";
import type { TeamTimelineEntry } from "@/types/matchup-detail";
import {
  computeTeamMetrics,
  formatSimpleRecord
} from "@/lib/team-metrics";

const STARTER_SLOT_ORDER: Record<string, number> = {
  QB: 0,
  TQB: 0,
  "QB/RB": 1,
  RB: 1,
  "RB/WR": 2,
  WR: 2,
  "WR/TE": 3,
  TE: 3,
  FLEX: 4,
  "W/R": 4,
  "W/T": 4,
  "R/T": 4,
  "Q/W/R/T": 5,
  OP: 6,
  SUPER_FLEX: 7,
  "D/ST": 8,
  DST: 8,
  K: 9,
};

const PLAYER_SLOT_CLASS = "text-[0.78rem] font-semibold uppercase tracking-[0.12em] text-[var(--accent)]";
const PLAYER_NAME_CLASS = "text-[0.92rem] text-[var(--text-soft)]";
const PLAYER_POINTS_CLASS = "text-sm text-[var(--text-muted)]";

function slotRank(slot: string | null | undefined): number {
  if (!slot) return 50;
  return STARTER_SLOT_ORDER[slot] ?? 40;
}

function sortPlayers(players: SimulationPlayer[] | null | undefined): SimulationPlayer[] {
  if (!players) return [];
  return [...players].sort((a, b) => {
    const rankDiff = slotRank(a.lineup_slot) - slotRank(b.lineup_slot);
    if (rankDiff !== 0) return rankDiff;
    const pointsDiff = (b.projected_points ?? 0) - (a.projected_points ?? 0);
    if (pointsDiff !== 0) return pointsDiff;
    return a.player_name.localeCompare(b.player_name);
  });
}

function formatPercent(value: number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return `${Math.round(value * 100)}%`;
}

function formatSeed(seed: number | null | undefined): string | null {
  if (seed === null || seed === undefined) {
    return null;
  }
  const suffix = seed === 1 ? "st" : seed === 2 ? "nd" : seed === 3 ? "rd" : "th";
  return `Best seed: #${seed}${suffix}`;
}

function formatActualMargin(pointsFor: number | null, pointsAgainst: number | null, status?: string | null): string {
  if (pointsFor === null || pointsAgainst === null) return "";
  if (status === "in_progress") {
    const liveDiff = pointsFor - pointsAgainst;
    if (Math.abs(liveDiff) < 0.25) return "Currently tied";
    if (liveDiff > 0) return `Leading by ${liveDiff.toFixed(1)}`;
    return `Trailing by ${Math.abs(liveDiff).toFixed(1)}`;
  }
  const diff = pointsFor - pointsAgainst;
  if (Math.abs(diff) < 0.25) return "Tied";
  if (diff > 0) return `Won by ${diff.toFixed(1)}`;
  return `Lost by ${Math.abs(diff).toFixed(1)}`;
}

type TeamPageProps = {
  params: Promise<{ teamId: string }>;
  searchParams?: Promise<{ scenario?: ScenarioSearchParam }>;
};

export default async function TeamPage({ params, searchParams }: TeamPageProps) {
  const { teamId: teamIdParam } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const teamId = Number(teamIdParam);
  if (!Number.isFinite(teamId)) {
    notFound();
  }

  const requestedScenario = normalizeScenarioId(resolvedSearchParams?.scenario);

  let simulation = await getLatestSimulation(requestedScenario);
  let activeScenarioId = requestedScenario;

  if (!simulation && requestedScenario !== BASELINE_SCENARIO_ID) {
    simulation = await getLatestSimulation(BASELINE_SCENARIO_ID);
    activeScenarioId = BASELINE_SCENARIO_ID;
  }

  if (!simulation) {
    notFound();
  }

  const lookup = buildSimulationLookup(simulation);
  const teamContext = getTeamContext(simulation, teamId, lookup);
  if (!teamContext) {
    notFound();
  }

  const scenarios = await listScenarios(simulation.season);

  const { team, standing, monteCarlo, schedule, nextMatchup } = teamContext;
  const playoffOdds = formatPercent(monteCarlo?.playoff_odds ?? null);
  const topSeedOdds = formatPercent(monteCarlo?.top_seed_odds ?? null);
  const bestSeedCopy = formatSeed(monteCarlo?.best_seed ?? null);

  const teamMetrics = computeTeamMetrics(schedule);
  const completedGames = schedule.filter((entry) => entry.isActual && entry.status === "final");
  const upcomingGames = schedule.filter((entry) => !entry.isActual || entry.status === "in_progress");

  const pointsFor = teamMetrics.pointsFor;
  const pointsAgainst = teamMetrics.pointsAgainst;
  const pointDifferential = teamMetrics.pointDifferential;
  const pointsPerGame = teamMetrics.pointsPerGame;
  const opponentPointsPerGame = teamMetrics.gamesPlayed > 0 ? teamMetrics.pointsAgainst / teamMetrics.gamesPlayed : null;
  const averageMargin = teamMetrics.gamesPlayed > 0 ? teamMetrics.pointDifferential / teamMetrics.gamesPlayed : null;

  let biggestWin: { week: number; diff: number; opponent: string } | null = null;
  let toughestLoss: { week: number; diff: number; opponent: string } | null = null;
  let streakType: "win" | "loss" | "tie" | null = null;
  let streakLength = 0;

  for (const entry of completedGames) {
    const diff = (entry.actualPoints ?? 0) - (entry.opponentActualPoints ?? 0);
    const opponentName = entry.opponent?.name ?? `Team ${entry.opponent_team_id}`;
    if (diff > 0) {
      if (!biggestWin || diff > biggestWin.diff) {
        biggestWin = { week: entry.week, diff, opponent: opponentName };
      }
      if (streakType === "win") {
        streakLength += 1;
      } else {
        streakType = "win";
        streakLength = 1;
      }
    } else if (diff < 0) {
      if (!toughestLoss || diff < toughestLoss.diff) {
        toughestLoss = { week: entry.week, diff, opponent: opponentName };
      }
      if (streakType === "loss") {
        streakLength += 1;
      } else {
        streakType = "loss";
        streakLength = 1;
      }
    } else {
      if (streakType === "tie") {
        streakLength += 1;
      } else {
        streakType = "tie";
        streakLength = 1;
      }
    }

  }

  const upcomingAvgWins = teamMetrics.upcomingAvgWins;
  const upcomingAvgPlayoffOdds = teamMetrics.upcomingAvgPlayoffOdds;

  const streakCopy = teamMetrics.currentStreak
    ? `${teamMetrics.currentStreak.length} ${teamMetrics.currentStreak.type === "win" ? "game win" : teamMetrics.currentStreak.type === "loss" ? "game skid" : "game tie"}`
    : null;

  const upcomingStrengthCopy =
    upcomingAvgWins !== null && upcomingAvgPlayoffOdds !== null
      ? `${upcomingAvgWins.toFixed(1)} avg wins · ${(upcomingAvgPlayoffOdds * 100).toFixed(0)}% avg playoff odds`
      : null;

  const liveGame = schedule.find((entry) => entry.status === "in_progress") ?? null;
  const lastGame = completedGames.at(-1) ?? null;
  const nextGame = nextMatchup ?? teamMetrics.nextGame ?? upcomingGames.at(0) ?? null;

  const opponentContext = (() => {
    if (!nextGame) return null;
    const opponentTeamId =
      typeof nextGame.opponent?.team_id === "number"
        ? nextGame.opponent.team_id
        : nextGame.opponent_team_id ?? null;
    if (!opponentTeamId) return null;
    const opponentSchedule = getTeamSchedule(simulation, opponentTeamId, lookup);
    if (opponentSchedule.length === 0) return null;
    return {
      teamId: opponentTeamId,
      metrics: computeTeamMetrics(opponentSchedule),
      standing: lookup.standingsByTeamId.get(opponentTeamId) ?? null,
    };
  })();

  const opponentMetrics = opponentContext?.metrics ?? null;
  const opponentStanding = opponentContext?.standing ?? null;

  const starters = nextGame ? sortPlayers(nextGame.teamProjection?.starters) : [];
  const bench = nextGame ? sortPlayers(nextGame.teamProjection?.bench) : [];
  const opponentStarters = nextGame ? sortPlayers(nextGame.opponentProjection?.starters) : [];

  const nextGameContent = (
    <MatchupCard
      matchup={nextGame}
      opponentMetrics={opponentMetrics}
      opponentStandingProjected={opponentStanding?.projected_record ?? null}
    />
  );

  let runningWins = 0;
  let runningLosses = 0;
  let runningTies = 0;

  const timeline: TeamTimelineEntry[] = schedule.map((entry) => {
    const recordBefore = {
      wins: runningWins,
      losses: runningLosses,
      ties: runningTies,
    };

    let recordForRow = recordBefore;
    if (entry.isActual) {
      if (entry.result === "win") runningWins += 1;
      else if (entry.result === "loss") runningLosses += 1;
      else if (entry.result === "tie") runningTies += 1;
      recordForRow = {
        wins: runningWins,
        losses: runningLosses,
        ties: runningTies,
      };
    }

    const rawStatus = entry.status ?? (entry.isActual ? (entry.result ? "final" : "in_progress") : "upcoming");
    const status: "final" | "live" | "upcoming" | "future" = (() => {
      if (rawStatus === "in_progress") return "live";
      if (rawStatus === "final") return "final";
      return nextGame && entry.week === nextGame.week ? "upcoming" : "future";
    })();

    const opponent = entry.opponent;
    const tone = status === "final"
      ? entry.result === "win"
        ? "favorable"
        : entry.result === "loss"
          ? "underdog"
          : "coinflip"
      : status === "live"
        ? (() => {
            if (entry.actualPoints === null || entry.opponentActualPoints === null) return "coinflip";
            if (entry.actualPoints > entry.opponentActualPoints) return "favorable";
            if (entry.actualPoints < entry.opponentActualPoints) return "underdog";
            return "coinflip";
          })()
        : probabilityTone(entry.win_probability);

    return {
      week: entry.week,
      matchupId: entry.matchup_id,
      isHome: entry.is_home,
      opponent: {
        teamId: opponent?.team_id ?? entry.opponent_team_id ?? null,
        name: opponent ? opponent.name : `Team ${entry.opponent_team_id}`,
        abbrev: opponent?.abbrev ?? null,
      },
      status,
      result: entry.result,
      record: recordForRow,
      actualScore: entry.isActual
        ? {
            for: entry.actualPoints ?? null,
            against: entry.opponentActualPoints ?? null,
          }
        : null,
      projectedScore: {
        for: entry.projected_points,
        against: entry.opponent_projected_points,
      },
      margin: entry.isActual
        ? entry.actualPoints !== null && entry.opponentActualPoints !== null
          ? (entry.actualPoints ?? 0) - (entry.opponentActualPoints ?? 0)
          : null
        : entry.projected_margin,
      winProbability: entry.win_probability,
      tone,
    } satisfies TeamTimelineEntry;
  });

  const remainingGames = upcomingGames.length;

  return (
    <main className="shell">
      <nav className="app-nav">
        <Link href="/" className="app-nav__back">
          ← Back to league dashboard
        </Link>
      </nav>
      <article className="grid gap-8 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-[clamp(32px,4vw,40px)] shadow-[0_22px_60px_rgba(2,6,23,0.55)] backdrop-blur-[18px]">
        <div className="mb-5 flex flex-wrap items-end justify-end gap-4">
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenarioId} />
          <RefreshControls
            initialGeneratedAt={simulation.generated_at}
            scenarioId={activeScenarioId}
          />
        </div>

        <header className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-5">
            <div className="grid h-24 w-24 place-items-center rounded-[20px] border border-[var(--border)] bg-[rgba(15,23,42,0.7)] text-[1.6rem] font-semibold text-[var(--text-soft)]">
              {team.logo_url ? (
                <Image
                  src={team.logo_url}
                  alt={`${team.name} logo`}
                  width={96}
                  height={96}
                  unoptimized
                  priority
                />
              ) : (
                <span aria-hidden>{team.abbrev ?? team.name.slice(0, 2).toUpperCase()}</span>
              )}
            </div>
            <div className="space-y-2">
              <h1 className="text-[clamp(2.2rem,4vw,3rem)] font-semibold">{team.name}</h1>
              <p className="text-[0.95rem] text-[var(--text-muted)]">{formatOwners(team.owners)}</p>
            </div>
          </div>
          <div className="grid gap-4 text-sm sm:text-base xl:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
            <div>
              <span className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Current Record</span>
              <span className="block text-[1.1rem] font-semibold text-[var(--text-soft)]">{formatSimpleRecord({ wins: teamMetrics.wins, losses: teamMetrics.losses, ties: teamMetrics.ties })}</span>
            </div>
            <div>
              <span className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Points For</span>
              <span className="block text-[1.1rem] font-semibold text-[var(--text-soft)]">{pointsFor.toFixed(1)}</span>
            </div>
            <div>
              <span className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Points Against</span>
              <span className="block text-[1.1rem] font-semibold text-[var(--text-soft)]">{pointsAgainst.toFixed(1)}</span>
            </div>
            <div>
              <span className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Point Differential</span>
              <span
                className={clsx(
                  "block text-[1.1rem] font-semibold",
                  pointDifferential >= 0 ? "text-[var(--accent-strong)]" : "text-[var(--accent-warn)]",
                )}
              >
                {pointDifferential >= 0 ? "+" : ""}{pointDifferential.toFixed(1)}
              </span>
            </div>
            {standing ? (
              <div>
                <span className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Projected Record</span>
                <span className="block text-[1.1rem] font-semibold text-[var(--text-soft)]">{formatSimpleRecord(standing.projected_record)}</span>
              </div>
            ) : null}
            {standing ? (
              <div>
                <span className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Projected Points</span>
                <span className="block text-[1.1rem] font-semibold text-[var(--text-soft)]">{standing.projected_points.toFixed(0)}</span>
              </div>
            ) : null}
            {playoffOdds ? (
              <div>
                <span className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Playoff Odds</span>
                <span className="block text-[1.1rem] font-semibold text-[var(--accent-strong)]">{playoffOdds}</span>
              </div>
            ) : null}
            {topSeedOdds ? (
              <div>
                <span className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">#1 Seed Odds</span>
                <span className="block text-[1.1rem] font-semibold text-[var(--text-soft)]">{topSeedOdds}</span>
              </div>
            ) : null}
            {bestSeedCopy ? (
              <div>
                <span className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Ceiling</span>
                <span className="block text-[1.1rem] font-semibold text-[var(--text-soft)]">{bestSeedCopy}</span>
              </div>
            ) : null}
          </div>
        </header>

        <section className="grid gap-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(13,20,36,0.78)] p-6">
          <header className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--text-muted)]">
            <h2 className="text-lg font-semibold text-[var(--text-soft)]">Season Snapshot</h2>
            <span>{schedule.length} weeks · {remainingGames} games remaining</span>
          </header>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
            <TeamSummaryCard eyebrow="Efficiency" title="Per-Game Production">
              <p className="text-[0.95rem] text-[var(--text-soft)]">{pointsPerGame !== null ? `${pointsPerGame.toFixed(1)} PF · ${opponentPointsPerGame?.toFixed(1) ?? "—"} PA` : "—"}</p>
              <p className="text-sm text-[var(--text-muted)]">
                Avg margin {averageMargin !== null ? `${averageMargin >= 0 ? "+" : ""}${averageMargin.toFixed(1)} pts` : "—"}
              </p>
            </TeamSummaryCard>
            <TeamSummaryCard eyebrow="Momentum" title={liveGame ? `Week ${liveGame.week} • Live` : lastGame ? `Week ${lastGame.week} ${lastGame.result === "win" ? "Win" : lastGame.result === "loss" ? "Loss" : "Tie"}` : "Last Result"}>
              {liveGame ? (
                <>
                  <p className="text-[0.95rem] text-[var(--text-soft)]">
                    {(liveGame.actualPoints ?? liveGame.projected_points).toFixed(1)} –
                    {(liveGame.opponentActualPoints ?? liveGame.opponent_projected_points).toFixed(1)}
                  </p>
                  <p className="text-sm text-[var(--text-muted)]">{formatActualMargin(liveGame.actualPoints, liveGame.opponentActualPoints, liveGame.status)}</p>
                </>
              ) : lastGame ? (
                <>
                  <p className="text-[0.95rem] text-[var(--text-soft)]">
                    {(lastGame.actualPoints ?? lastGame.projected_points).toFixed(1)} –
                    {(lastGame.opponentActualPoints ?? lastGame.opponent_projected_points).toFixed(1)}
                  </p>
                  <p className="text-sm text-[var(--text-muted)]">{formatActualMargin(lastGame.actualPoints, lastGame.opponentActualPoints, lastGame.status)}</p>
                </>
              ) : (
                <p className="text-sm text-[var(--text-muted)]">Season has not started yet.</p>
              )}
              {streakCopy ? <p className="text-sm font-semibold text-[var(--accent)]">{streakCopy}</p> : null}
            </TeamSummaryCard>
            <TeamSummaryCard eyebrow={liveGame ? "Now Playing" : "Coming Up"}>
              <MatchupCard
                matchup={nextGame}
                opponentMetrics={opponentMetrics}
                opponentStandingProjected={opponentStanding?.projected_record ?? null}
              />
              {upcomingStrengthCopy ? (
                <p className="text-sm text-[var(--text-muted)]">Avg opponent outlook: {upcomingStrengthCopy}</p>
              ) : null}
            </TeamSummaryCard>
            <TeamSummaryCard eyebrow="Extremes" title="Highs &amp; Lows">
              <p className="text-[0.95rem] text-[var(--text-soft)]">
                {biggestWin
                  ? `Biggest win: +${biggestWin.diff.toFixed(1)} vs ${biggestWin.opponent} (W${biggestWin.week})`
                  : "No wins yet."}
              </p>
              <p className="text-sm text-[var(--text-muted)]">
                {toughestLoss
                  ? `Toughest loss: ${toughestLoss.diff.toFixed(1)} vs ${toughestLoss.opponent} (W${toughestLoss.week})`
                  : "No losses yet."}
              </p>
            </TeamSummaryCard>
          </div>
        </section>

        <section className="grid gap-5">
          <header className="flex flex-wrap items-baseline justify-between gap-3 text-sm text-[var(--text-muted)]">
            <h2 className="text-lg font-semibold text-[var(--text-soft)]">Lineup Outlook</h2>
            {nextGame ? <span>Week {nextGame.week} matchup</span> : <span>Roster preview</span>}
          </header>
          {nextGame ? (
            <>
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
                <div className="grid gap-2 rounded-[var(--radius-sm)] border border-[rgba(148,163,184,0.2)] bg-[rgba(10,18,32,0.72)] px-[14px] py-3">
                  <span className="text-xs uppercase tracking-[0.14em] text-[var(--text-muted)]">Your season</span>
                  <span className="text-[1.05rem] font-semibold text-[var(--text-soft)]">{formatSimpleRecord({ wins: teamMetrics.wins, losses: teamMetrics.losses, ties: teamMetrics.ties })}</span>
                  <span className="text-sm text-[var(--text-muted)]">PPG {pointsPerGame !== null ? pointsPerGame.toFixed(1) : "—"} · Diff {pointDifferential >= 0 ? '+' : ''}{pointDifferential.toFixed(1)}</span>
                </div>
                {opponentMetrics ? (
                  <div className="grid gap-2 rounded-[var(--radius-sm)] border border-[rgba(148,163,184,0.2)] bg-[rgba(10,18,32,0.72)] px-[14px] py-3">
                    <span className="text-xs uppercase tracking-[0.14em] text-[var(--text-muted)]">Opponent season</span>
                    <span className="text-[1.05rem] font-semibold text-[var(--text-soft)]">{formatSimpleRecord({ wins: opponentMetrics.wins, losses: opponentMetrics.losses, ties: opponentMetrics.ties })}</span>
                    <span className="text-sm text-[var(--text-muted)]">PPG {opponentMetrics.pointsPerGame !== null ? opponentMetrics.pointsPerGame.toFixed(1) : opponentMetrics.pointsFor.toFixed(1)} · Diff {opponentMetrics.pointDifferential >= 0 ? '+' : ''}{opponentMetrics.pointDifferential.toFixed(1)}</span>
                    {opponentStanding ? (
                      <span className="text-sm text-[var(--text-muted)]">Projected {formatSimpleRecord(opponentStanding.projected_record)}</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="grid gap-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(13,22,40,0.7)] p-5 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
                <div className="space-y-3">
                  <h3 className="text-base font-semibold text-[var(--text-soft)]">Starters</h3>
                  <ul className="grid gap-2">
                    {starters.length === 0 ? (
                      <li className="text-sm text-[var(--text-muted)]">No starters projected.</li>
                    ) : (
                      starters.map((player) => (
                        <li
                          key={`${player.espn_player_id ?? player.player_name}-${player.lineup_slot}`}
                          className="grid grid-cols-[60px,1fr,auto] items-center gap-3 rounded-[10px] border border-[rgba(255,255,255,0.06)] bg-[rgba(9,15,28,0.65)] px-3 py-2 text-[0.95rem]"
                        >
                          <span className={PLAYER_SLOT_CLASS}>{player.lineup_slot}</span>
                          <span className={PLAYER_NAME_CLASS}>{player.player_name}</span>
                          <span className={PLAYER_POINTS_CLASS}>{player.projected_points.toFixed(1)} pts</span>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
                <div className="space-y-3">
                  <h3 className="text-base font-semibold text-[var(--text-soft)]">Bench</h3>
                  <ul className="grid gap-2">
                    {bench.length === 0 ? (
                      <li className="text-sm text-[var(--text-muted)]">Bench not available.</li>
                    ) : (
                      bench.map((player) => (
                        <li
                          key={`${player.espn_player_id ?? player.player_name}-${player.lineup_slot}`}
                          className="grid grid-cols-[60px,1fr,auto] items-center gap-3 rounded-[10px] border border-[rgba(255,255,255,0.06)] bg-[rgba(9,15,28,0.65)] px-3 py-2 text-[0.95rem]"
                        >
                          <span className={PLAYER_SLOT_CLASS}>{player.lineup_slot}</span>
                          <span className={PLAYER_NAME_CLASS}>{player.player_name}</span>
                          <span className={PLAYER_POINTS_CLASS}>{player.projected_points.toFixed(1)} pts</span>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
                <div className="space-y-3">
                  <h3 className="text-base font-semibold text-[var(--text-soft)]">Opponent Starters</h3>
                  <ul className="grid gap-2">
                    {opponentStarters.length === 0 ? (
                      <li className="text-sm text-[var(--text-muted)]">Opponent lineup not available.</li>
                    ) : (
                      opponentStarters.map((player) => (
                        <li
                          key={`${player.espn_player_id ?? player.player_name}-${player.lineup_slot}`}
                          className="grid grid-cols-[60px,1fr,auto] items-center gap-3 rounded-[10px] border border-[rgba(255,255,255,0.06)] bg-[rgba(9,15,28,0.65)] px-3 py-2 text-[0.95rem]"
                        >
                          <span className={PLAYER_SLOT_CLASS}>{player.lineup_slot}</span>
                          <span className={PLAYER_NAME_CLASS}>{player.player_name}</span>
                          <span className={PLAYER_POINTS_CLASS}>{player.projected_points.toFixed(1)} pts</span>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">Lineup information becomes available once projections are published.</p>
          )}
        </section>

        <ScenarioDrawer
          season={simulation.season}
          scenarios={scenarios}
          activeScenarioId={activeScenarioId}
        />

        <TeamTimeline
          season={simulation.season}
          scenarioId={activeScenarioId}
          entries={timeline}
        />
      </article>
    </main>
  );
}
