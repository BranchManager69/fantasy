import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import {
  formatMargin,
  formatOwners,
  formatRecord,
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

  const nextGameContent = (() => {
    if (!nextGame) {
      return (
        <>
          <h3>No games remaining</h3>
          <p className="team-summary__meta">Regular season complete.</p>
        </>
      );
    }

    const nextStatus = nextGame.status ?? (nextGame.isActual ? (nextGame.result ? "final" : "in_progress") : "upcoming");
    const isNextLive = nextStatus === "in_progress";
    const isNextFinal = nextStatus === "final";
    const labelPrefix = isNextLive ? "Live" : isNextFinal ? "Final" : "Upcoming";
    const matchupHeading = (
      <h3>
        Week {nextGame.week} • {labelPrefix} {nextGame.is_home ? "vs" : "@"}{" "}
        {nextGame.opponent ? (
          <Link href={`/teams/${nextGame.opponent.team_id}`}>
            {nextGame.opponent.name}
          </Link>
        ) : (
          `Team ${nextGame.opponent_team_id}`
        )}
      </h3>
    );

    let body: ReactNode;
    if (isNextLive) {
      const liveFor = (nextGame.actualPoints ?? nextGame.projected_points).toFixed(1);
      const liveAgainst = (nextGame.opponentActualPoints ?? nextGame.opponent_projected_points).toFixed(1);
      body = (
        <>
          <p>{liveFor} – {liveAgainst}</p>
          <p className="team-summary__meta">
            {formatActualMargin(nextGame.actualPoints, nextGame.opponentActualPoints, nextStatus)} • {probabilityLabel(nextGame.win_probability)}
          </p>
        </>
      );
    } else if (isNextFinal) {
      const finalFor = (nextGame.actualPoints ?? nextGame.projected_points).toFixed(1);
      const finalAgainst = (nextGame.opponentActualPoints ?? nextGame.opponent_projected_points).toFixed(1);
      body = (
        <>
          <p>{finalFor} – {finalAgainst}</p>
          <p className="team-summary__meta">{formatActualMargin(nextGame.actualPoints, nextGame.opponentActualPoints, nextStatus)}</p>
        </>
      );
    } else {
      body = (
        <>
          <p>{nextGame.projected_points.toFixed(1)} – {nextGame.opponent_projected_points.toFixed(1)}</p>
          <p className="team-summary__meta">
            {probabilityLabel(nextGame.win_probability)} · {formatMargin(nextGame.projected_margin)}
          </p>
        </>
      );
    }

    return (
      <>
        {matchupHeading}
        {body}
        {opponentMetrics ? (
          <>
            <p className="team-summary__meta">
              Opponent record {formatSimpleRecord({
                wins: opponentMetrics.wins,
                losses: opponentMetrics.losses,
                ties: opponentMetrics.ties,
              })}
              {opponentMetrics.pointsPerGame !== null
                ? ` · ${opponentMetrics.pointsPerGame.toFixed(1)} PPG`
                : ` · ${opponentMetrics.pointsFor.toFixed(1)} PF`}
            </p>
            {opponentStanding ? (
              <p className="team-summary__meta">Projected {formatRecord(opponentStanding.projected_record)}</p>
            ) : null}
          </>
        ) : null}
      </>
    );
  })();

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
      <article className="panel team-panel">
        <div className="panel-actions">
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenarioId} />
          <RefreshControls
            initialGeneratedAt={simulation.generated_at}
            scenarioId={activeScenarioId}
          />
        </div>

        <header className="team-hero">
          <div className="team-hero__identity">
            <div className="team-hero__logo">
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
            <div className="team-hero__meta">
              <h1>{team.name}</h1>
              <p className="team-hero__owners">{formatOwners(team.owners)}</p>
            </div>
          </div>
          <div className="team-hero__stats">
            <div>
              <span className="team-hero__label">Current Record</span>
              <span className="team-hero__value">{formatSimpleRecord({ wins: teamMetrics.wins, losses: teamMetrics.losses, ties: teamMetrics.ties })}</span>
            </div>
            <div>
              <span className="team-hero__label">Points For</span>
              <span className="team-hero__value">{pointsFor.toFixed(1)}</span>
            </div>
            <div>
              <span className="team-hero__label">Points Against</span>
              <span className="team-hero__value">{pointsAgainst.toFixed(1)}</span>
            </div>
            <div>
              <span className="team-hero__label">Point Differential</span>
              <span className={`team-hero__value ${pointDifferential >= 0 ? "team-hero__value--accent" : "team-hero__value--warn"}`}>
                {pointDifferential >= 0 ? "+" : ""}{pointDifferential.toFixed(1)}
              </span>
            </div>
            {standing ? (
              <div>
                <span className="team-hero__label">Projected Record</span>
                <span className="team-hero__value">{formatRecord(standing.projected_record)}</span>
              </div>
            ) : null}
            {standing ? (
              <div>
                <span className="team-hero__label">Projected Points</span>
                <span className="team-hero__value">{standing.projected_points.toFixed(0)}</span>
              </div>
            ) : null}
            {playoffOdds ? (
              <div>
                <span className="team-hero__label">Playoff Odds</span>
                <span className="team-hero__value team-hero__value--accent">{playoffOdds}</span>
              </div>
            ) : null}
            {topSeedOdds ? (
              <div>
                <span className="team-hero__label">#1 Seed Odds</span>
                <span className="team-hero__value">{topSeedOdds}</span>
              </div>
            ) : null}
            {bestSeedCopy ? (
              <div>
                <span className="team-hero__label">Ceiling</span>
                <span className="team-hero__value">{bestSeedCopy}</span>
              </div>
            ) : null}
          </div>
        </header>

        <section className="team-summary">
          <header>
            <h2>Season Snapshot</h2>
            <span>{schedule.length} weeks · {remainingGames} games remaining</span>
          </header>
          <div className="team-summary__grid">
            <div className="team-summary__card">
              <span className="team-summary__eyebrow">Efficiency</span>
              <h3>Per-Game Production</h3>
              <p>{pointsPerGame !== null ? `${pointsPerGame.toFixed(1)} PF · ${opponentPointsPerGame?.toFixed(1) ?? "—"} PA` : "—"}</p>
              <p className="team-summary__meta">
                Avg margin {averageMargin !== null ? `${averageMargin >= 0 ? "+" : ""}${averageMargin.toFixed(1)} pts` : "—"}
              </p>
            </div>
            <div className="team-summary__card">
              <span className="team-summary__eyebrow">Momentum</span>
              {liveGame ? (
                <>
                  <h3>Week {liveGame.week} • Live</h3>
                  <p>
                    {(liveGame.actualPoints ?? liveGame.projected_points).toFixed(1)} –
                    {(liveGame.opponentActualPoints ?? liveGame.opponent_projected_points).toFixed(1)}
                  </p>
                  <p className="team-summary__meta">{formatActualMargin(liveGame.actualPoints, liveGame.opponentActualPoints, liveGame.status)}</p>
                </>
              ) : lastGame ? (
                <>
                  <h3>
                    Week {lastGame.week} {lastGame.result === "win" ? "Win" : lastGame.result === "loss" ? "Loss" : "Tie"}
                  </h3>
                  <p>
                    {(lastGame.actualPoints ?? lastGame.projected_points).toFixed(1)} –
                    {(lastGame.opponentActualPoints ?? lastGame.opponent_projected_points).toFixed(1)}
                  </p>
                  <p className="team-summary__meta">{formatActualMargin(lastGame.actualPoints, lastGame.opponentActualPoints, lastGame.status)}</p>
                </>
              ) : (
                <>
                  <h3>Last Result</h3>
                  <p className="team-summary__meta">Season has not started yet.</p>
                </>
              )}
              {streakCopy ? <p className="team-summary__meta team-summary__meta--accent">{streakCopy}</p> : null}
            </div>
            <div className="team-summary__card">
              <span className="team-summary__eyebrow">Coming Up</span>
              {nextGameContent}
              {upcomingStrengthCopy ? (
                <p className="team-summary__meta">Avg opponent outlook: {upcomingStrengthCopy}</p>
              ) : null}
            </div>
            <div className="team-summary__card">
              <span className="team-summary__eyebrow">Extremes</span>
              <h3>Highs &amp; Lows</h3>
              <p>
                {biggestWin
                  ? `Biggest win: +${biggestWin.diff.toFixed(1)} vs ${biggestWin.opponent} (W${biggestWin.week})`
                  : "No wins yet."}
              </p>
              <p className="team-summary__meta">
                {toughestLoss
                  ? `Toughest loss: ${toughestLoss.diff.toFixed(1)} vs ${toughestLoss.opponent} (W${toughestLoss.week})`
                  : "No losses yet."}
              </p>
            </div>
          </div>
        </section>

        <section className="team-roster">
          <header>
            <h2>Lineup Outlook</h2>
            {nextGame ? <span>Week {nextGame.week} matchup</span> : <span>Roster preview</span>}
          </header>
          {nextGame ? (
            <>
              <div className="team-roster__metrics">
                <div>
                  <span className="team-roster__metrics-label">Your season</span>
                  <span className="team-roster__metrics-value">{formatSimpleRecord({ wins: teamMetrics.wins, losses: teamMetrics.losses, ties: teamMetrics.ties })}</span>
                  <span className="team-roster__metrics-sub">PPG {pointsPerGame !== null ? pointsPerGame.toFixed(1) : "—"} · Diff {pointDifferential >= 0 ? '+' : ''}{pointDifferential.toFixed(1)}</span>
                </div>
                {opponentMetrics ? (
                  <div>
                    <span className="team-roster__metrics-label">Opponent season</span>
                    <span className="team-roster__metrics-value">{formatSimpleRecord({ wins: opponentMetrics.wins, losses: opponentMetrics.losses, ties: opponentMetrics.ties })}</span>
                    <span className="team-roster__metrics-sub">PPG {opponentMetrics.pointsPerGame !== null ? opponentMetrics.pointsPerGame.toFixed(1) : opponentMetrics.pointsFor.toFixed(1)} · Diff {opponentMetrics.pointDifferential >= 0 ? '+' : ''}{opponentMetrics.pointDifferential.toFixed(1)}</span>
                    {opponentStanding ? (
                      <span className="team-roster__metrics-sub">Projected {formatRecord(opponentStanding.projected_record)}</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="team-roster__grid">
              <div>
                <h3>Starters</h3>
                <ul>
                  {starters.length === 0 ? (
                    <li className="team-roster__empty">No starters projected.</li>
                  ) : (
                    starters.map((player) => (
                      <li key={`${player.espn_player_id ?? player.player_name}-${player.lineup_slot}`}>
                        <span className="player-slot">{player.lineup_slot}</span>
                        <span className="player-name">{player.player_name}</span>
                        <span className="player-points">{player.projected_points.toFixed(1)} pts</span>
                      </li>
                    ))
                  )}
                </ul>
              </div>
              <div>
                <h3>Bench</h3>
                <ul>
                  {bench.length === 0 ? (
                    <li className="team-roster__empty">Bench not available.</li>
                  ) : (
                    bench.map((player) => (
                      <li key={`${player.espn_player_id ?? player.player_name}-${player.lineup_slot}`}>
                        <span className="player-slot">{player.lineup_slot}</span>
                        <span className="player-name">{player.player_name}</span>
                        <span className="player-points">{player.projected_points.toFixed(1)} pts</span>
                      </li>
                    ))
                  )}
                </ul>
              </div>
              <div>
                <h3>Opponent Starters</h3>
                <ul>
                  {opponentStarters.length === 0 ? (
                    <li className="team-roster__empty">Opponent lineup not available.</li>
                  ) : (
                    opponentStarters.map((player) => (
                      <li key={`${player.espn_player_id ?? player.player_name}-${player.lineup_slot}`}>
                        <span className="player-slot">{player.lineup_slot}</span>
                        <span className="player-name">{player.player_name}</span>
                        <span className="player-points">{player.projected_points.toFixed(1)} pts</span>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </div>
          </>
          ) : (
            <p className="team-roster__empty">Lineup information becomes available once projections are published.</p>
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
