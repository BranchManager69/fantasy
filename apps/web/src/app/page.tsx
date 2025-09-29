import Link from "next/link";

import {
  formatFinalMargin,
  formatLiveMargin,
  formatMargin,
  formatOwners,
  probabilityClass,
  probabilityLabel,
} from "@/lib/formatters";
import { RefreshControls } from "@/components/refresh-controls";
import { ScenarioDrawer } from "@/components/scenario-drawer";
import { ScenarioSwitcher } from "@/components/scenario-switcher";
import { LiveActivityFeed } from "@/components/live-activity-feed";
import { OwnerAvatars } from "@/components/owner-avatars";
import {
  type MonteCarloSummary,
  type MonteCarloTeamSummary,
  type RestOfSeasonSimulation,
  type SimulationStanding,
  type SimulationTeamMeta,
  type TeamScheduleWithContext,
  buildSimulationLookup,
  getLatestSimulation,
  getTeamSchedule,
} from "@/lib/simulator-data";
import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";
import { listScenarios } from "@/lib/scenario-data";
import { normalizeScenarioId, type ScenarioSearchParam } from "@/lib/scenario-utils";
import {
  betterRecord,
  computeTeamMetrics,
  formatSimpleRecord,
  type TeamLeagueMetrics,
} from "@/lib/team-metrics";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function WeekHeader({ weeks }: { weeks: number[] }) {
  return (
    <thead>
      <tr>
        <th scope="col">Team Outlook</th>
        {weeks.map((week) => (
          <th key={week} scope="col">
            Week {week}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function TeamRow({
  team,
  record,
  weeks,
  schedule,
  monteCarlo,
}: {
  team: SimulationTeamMeta;
  record: SimulationStanding["projected_record"];
  weeks: number[];
  schedule: TeamScheduleWithContext[];
  monteCarlo?: MonteCarloTeamSummary | null;
}) {
  const weeklyMap = new Map<number, TeamScheduleWithContext>(
    schedule.map((entry) => [entry.week, entry] as const),
  );
  const mc = monteCarlo ?? null;
  const playoffCopy = mc ? `${Math.round(mc.playoff_odds * 100)}% playoff odds` : null;
  const seedCopy = mc && mc.top_seed_odds > 0.01 ? `${Math.round(mc.top_seed_odds * 100)}% for #1 seed` : null;
  const projectedWins = record?.wins ?? null;
  const winsDeltaRaw = mc && projectedWins !== null ? mc.average_wins - projectedWins : null;
  const avgWinsCopy = winsDeltaRaw !== null && Math.abs(winsDeltaRaw) >= 0.3
    ? `${winsDeltaRaw >= 0 ? "+" : ""}${winsDeltaRaw.toFixed(1)}W`
    : null;
  return (
    <tr>
      <th scope="row">
        <div className="team-heading">
          <Link href={`/teams/${team.team_id}`} className="team-heading__name" title={team.name}>
            {team.name}
          </Link>
          <span className="team-heading__owners" title={formatOwners(team.owners)}>
            <OwnerAvatars teamId={team.team_id} ownersCount={team.owners.length} /> {formatOwners(team.owners)}
          </span>
          <div className="team-heading__meta">
            <span className="team-heading__record">{formatSimpleRecord(record)}</span>
            {avgWinsCopy ? (
              <span className="team-heading__avg" title="Expected wins vs projected record (Monte Carlo)">{avgWinsCopy}</span>
            ) : null}
            {playoffCopy ? <span className="team-heading__prob">{playoffCopy}</span> : null}
            {seedCopy ? <span className="team-heading__seed">{seedCopy}</span> : null}
          </div>
        </div>
      </th>
      {weeks.map((week) => {
        const entry = weeklyMap.get(week);
        if (!entry) {
          return (
            <td key={week} className="cell cell--empty">
              —
            </td>
          );
        }
        const opponent = entry.opponent;
        const opponentLabel = opponent ? opponent.abbrev || opponent.name : `Team ${entry.opponent_team_id}`;
        const opponentHref = opponent ? `/teams/${opponent.team_id}` : null;
        const direction = entry.is_home ? "vs" : "@";
        const isActual = entry.isActual;
        const status = entry.status ?? (isActual ? (entry.result ? "final" : "in_progress") : "upcoming");
        const isLive = isActual && status === "in_progress";
        const isFinal = isActual && status === "final";
        const cellClass = isActual
          ? `cell cell--actual ${isLive ? "cell--actual-live" : `cell--actual-${entry.result ?? "tie"}`}`
          : probabilityClass(entry.win_probability);
        const pointsFor = isActual ? entry.actualPoints ?? entry.projected_points : entry.projected_points;
        const pointsAgainst = isActual
          ? entry.opponentActualPoints ?? entry.opponent_projected_points
          : entry.opponent_projected_points;
        const pointsValue = pointsFor.toFixed(1);
        const opponentPointsValue = pointsAgainst.toFixed(1);
        const actualMargin =
          entry.actualPoints !== null && entry.opponentActualPoints !== null
            ? entry.actualPoints - entry.opponentActualPoints
            : entry.projected_margin;
        const marginCopy = isActual
          ? isLive
            ? formatLiveMargin(entry.actualPoints, entry.opponentActualPoints)
            : formatFinalMargin(actualMargin)
          : formatMargin(entry.projected_margin);
        const winPct = Math.round(entry.win_probability * 100);
        const resultLabel = isLive
          ? "Live"
          : entry.result === "win"
            ? "Won"
            : entry.result === "loss"
              ? "Lost"
              : entry.result === "tie"
                ? "Tied"
                : "Final";
        return (
          <td key={week} className={cellClass}>
            <div className="cell__body">
              <div className="cell__points">{pointsValue} pts</div>
              <div className="cell__opponent-row">
                <span className="cell__opponent-dir">{direction}</span>
                <span className="cell__opponent-name">
                  {opponentHref ? <Link href={opponentHref}>{opponentLabel}</Link> : opponentLabel}
                </span>
                <span className="cell__opponent-opp">{opponentPointsValue} pts</span>
              </div>
              <div className="cell__margin">{marginCopy}</div>
              {isActual ? (
                <div className={`cell__prob ${isLive ? "cell__prob--live" : "cell__prob--final"}`}>
                  <span className="cell__prob-value">{resultLabel} • {pointsValue} – {opponentPointsValue}</span>
                  {isLive ? (
                    <span className="cell__prob-note">{probabilityLabel(entry.win_probability)}</span>
                  ) : null}
                </div>
              ) : (
                <div className="cell__prob">
                  <span className="cell__prob-value">{probabilityLabel(entry.win_probability)}</span>
                  <div className="cell__prob-bar">
                    <span style={{ width: `${winPct}%` }} />
                  </div>
                </div>
              )}
            </div>
          </td>
        );
      })}
    </tr>
  );
}


type PageSearchParams = {
  scenario?: ScenarioSearchParam;
};

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<PageSearchParams>;
}) {
  const resolvedParams = searchParams ? await searchParams : undefined;
  const requestedScenario = normalizeScenarioId(resolvedParams?.scenario);

  let simulation = await getLatestSimulation(requestedScenario);
  let activeScenarioId = requestedScenario;

  if (!simulation && requestedScenario !== BASELINE_SCENARIO_ID) {
    simulation = await getLatestSimulation(BASELINE_SCENARIO_ID);
    activeScenarioId = BASELINE_SCENARIO_ID;
  }

  if (!simulation) {
    return (
      <main className="shell">
        <section className="empty-state">
          <h1>No simulation artifacts yet</h1>
          <p>
            Kick off a backend refresh to build the rest-of-season projection grid. Run
            <code>poetry run fantasy refresh-all</code> and then reload this page.
          </p>
        </section>
      </main>
    );
  }

  const lookup = buildSimulationLookup(simulation);
  const standings = simulation.standings;
  const orderedTeams = standings.map((entry) => entry.team);
  const weeks = [...new Set(simulation.weeks.map((week) => week.week))].sort((a, b) => a - b);
  const firstWeek = weeks[0];
  const lastWeek = weeks[weeks.length - 1];
  const monteCarlo = simulation.monte_carlo;
  const scenarios = await listScenarios(simulation.season);

  const teamContexts = orderedTeams.map((team) => {
    const schedule = getTeamSchedule(simulation, team.team_id, lookup);
    const metrics = computeTeamMetrics(schedule);
    const standing = lookup.standingsByTeamId.get(team.team_id) ?? null;
    const monteCarloEntry = lookup.monteCarloByTeamId.get(team.team_id) ?? null;
    return {
      team,
      schedule,
      metrics,
      standing,
      monteCarlo: monteCarloEntry,
    };
  });

  const metricsByTeamId = new Map(teamContexts.map((context) => [context.team.team_id, context.metrics] as const));

  const highlightCards = (() => {
    if (teamContexts.length === 0) {
      return [] as {
        id: string;
        eyebrow: string;
        heading: string;
        link?: string | null;
        value: string;
        meta?: string | null;
        secondary?: string | null;
        extra?: string | null;
      }[];
    }

    const recordLeader = teamContexts.reduce((best, current) =>
      betterRecord(current.metrics, best.metrics) ? current : best,
      teamContexts[0],
    );

    const scoringLeader = teamContexts.reduce((best, current) => {
      const currentPpg = current.metrics.pointsPerGame ?? 0;
      const bestPpg = best.metrics.pointsPerGame ?? 0;
      if (currentPpg !== bestPpg) {
        return currentPpg > bestPpg ? current : best;
      }
      return current.metrics.pointsFor > best.metrics.pointsFor ? current : best;
    }, teamContexts[0]);

    const diffLeader = teamContexts.reduce((best, current) =>
      current.metrics.pointDifferential > best.metrics.pointDifferential ? current : best,
      teamContexts[0],
    );

    const contextsWithUpcoming = teamContexts.filter((context) => context.metrics.upcomingAvgWins !== null);
    const scheduleLeader = contextsWithUpcoming.length
      ? contextsWithUpcoming.reduce((best, current) => {
          const bestVal = best.metrics.upcomingAvgWins ?? -Infinity;
          const currentVal = current.metrics.upcomingAvgWins ?? -Infinity;
          if (currentVal !== bestVal) {
            return currentVal > bestVal ? current : best;
          }
          const bestOdds = best.metrics.upcomingAvgPlayoffOdds ?? -Infinity;
          const currentOdds = current.metrics.upcomingAvgPlayoffOdds ?? -Infinity;
          return currentOdds > bestOdds ? current : best;
        })
      : null;

    const cards: {
      id: string;
      eyebrow: string;
      heading: string;
      link?: string | null;
      value: string;
      meta?: string | null;
      secondary?: string | null;
      extra?: string | null;
    }[] = [];

    const recordProjected = recordLeader.standing?.projected_record;
    cards.push({
      id: "top-seed",
      eyebrow: "Top seed pace",
      heading: recordLeader.team.name,
      link: `/teams/${recordLeader.team.team_id}`,
      value: formatSimpleRecord({
        wins: recordLeader.metrics.wins,
        losses: recordLeader.metrics.losses,
        ties: recordLeader.metrics.ties,
      }),
      meta: recordProjected ? `Projected ${formatSimpleRecord(recordProjected)}` : null,
      secondary:
        recordLeader.metrics.pointDifferential !== 0
          ? `Diff ${recordLeader.metrics.pointDifferential >= 0 ? "+" : ""}${recordLeader.metrics.pointDifferential.toFixed(1)}`
          : undefined,
    });

    const scoringValue = scoringLeader.metrics.pointsPerGame ?? null;
    cards.push({
      id: "scoring-leader",
      eyebrow: "Scoring leader",
      heading: scoringLeader.team.name,
      link: `/teams/${scoringLeader.team.team_id}`,
      value:
        scoringValue !== null ? `${scoringValue.toFixed(1)} PPG` : `${scoringLeader.metrics.pointsFor.toFixed(1)} PF`,
      meta: `Total PF ${scoringLeader.metrics.pointsFor.toFixed(1)}`,
      secondary:
        scoringLeader.metrics.pointsPerGame !== null && scoringLeader.metrics.pointsPerGame > 0
          ? `Games played ${scoringLeader.metrics.wins + scoringLeader.metrics.losses + scoringLeader.metrics.ties}`
          : undefined,
    });

    cards.push({
      id: "point-diff",
      eyebrow: "Point differential",
      heading: diffLeader.team.name,
      link: `/teams/${diffLeader.team.team_id}`,
      value: `${diffLeader.metrics.pointDifferential >= 0 ? "+" : ""}${diffLeader.metrics.pointDifferential.toFixed(1)}`,
      meta: `Points allowed ${diffLeader.metrics.pointsAgainst.toFixed(1)}`,
    });

    if (scheduleLeader) {
      const avgWins = scheduleLeader.metrics.upcomingAvgWins ?? 0;
      const avgPlayoff = scheduleLeader.metrics.upcomingAvgPlayoffOdds ?? null;
      const nextGame = scheduleLeader.metrics.nextGame;
      const remainingSummary = (() => {
        const upcomingGames = scheduleLeader.schedule.filter((entry) => !entry.isActual);
        if (upcomingGames.length === 0) {
          return null;
        }

        const preview = upcomingGames.slice(0, 3).map((entry) => {
          const opponentLabel = entry.opponent?.abbrev || entry.opponent?.name || `Team ${entry.opponent_team_id}`;
          const projectedRecord = entry.opponentStanding?.projected_record;
          const recordCopy = projectedRecord ? formatSimpleRecord(projectedRecord) : null;
          const playoffOdds = entry.opponentMonteCarlo?.playoff_odds;
          const oddsCopy =
            typeof playoffOdds === "number" && Number.isFinite(playoffOdds)
              ? `${Math.round(playoffOdds * 100)}%`
              : null;
          if (recordCopy && oddsCopy) return `${opponentLabel} ${recordCopy} (${oddsCopy})`;
          if (recordCopy) return `${opponentLabel} ${recordCopy}`;
          if (oddsCopy) return `${opponentLabel} ${oddsCopy}`;
          return opponentLabel;
        });

        if (preview.length === 0) {
          return null;
        }

        const remainingCount = upcomingGames.length - preview.length;
        const joined = preview.join(", ");
        return remainingCount > 0 ? `Remaining: ${joined}, +${remainingCount} more` : `Remaining: ${joined}`;
      })();
      cards.push({
        id: "tough-schedule",
        eyebrow: "Toughest remaining slate",
        heading: scheduleLeader.team.name,
        link: `/teams/${scheduleLeader.team.team_id}`,
        value: `${avgWins.toFixed(1)} opp avg wins`,
        meta: avgPlayoff !== null ? `Opp playoff odds ${(avgPlayoff * 100).toFixed(0)}%` : undefined,
        secondary: nextGame
          ? `Next: Week ${nextGame.week} ${nextGame.is_home ? "vs" : "@"} ${nextGame.opponent?.name ?? `Team ${nextGame.opponent_team_id}`}`
          : "No games remaining",
        extra: remainingSummary,
      });
    } else {
      cards.push({
        id: "tough-schedule",
        eyebrow: "Season outlook",
        heading: "Schedule locked",
        value: "—",
        meta: "All remaining games finalized",
      });
    }

    return cards;
  })();

  return (
    <main className="shell">
      <nav className="app-nav">
        <Link href="/" className="app-nav__brand">
          Fantasy League Engine
        </Link>
      </nav>
      <section className="panel matrix-panel">
        <header className="matrix-header">
          <div className="matrix-header__left">
            <h1>Season {simulation.season} · Weeks {firstWeek}–{lastWeek}</h1>
            <span>{simulation.weeks.length} weeks · {simulation.teams.length} teams</span>
          </div>
          {monteCarlo ? (
            <div className="matrix-header__stats">
              <span>{monteCarlo.iterations.toLocaleString()} Monte Carlo runs</span>
              <span>{monteCarlo.playoff_slots} playoff slots</span>
              {monteCarlo.random_seed !== null ? <span>Seed {monteCarlo.random_seed}</span> : null}
            </div>
          ) : null}
          <div className="matrix-header__actions">
            <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenarioId} />
            <RefreshControls
              initialGeneratedAt={simulation.generated_at}
              scenarioId={activeScenarioId}
            />
          </div>
        </header>
        <ScenarioDrawer
          season={simulation.season}
          scenarios={scenarios}
          activeScenarioId={activeScenarioId}
        />

        <LiveActivityFeed scenarioId={activeScenarioId} />

        {highlightCards.length > 0 ? (
          <section className="league-summary">
            <div className="league-summary__grid">
              {highlightCards.map((card) => (
                <article key={card.id} className="league-summary__card">
                  <span className="league-summary__eyebrow">{card.eyebrow}</span>
                  {card.link ? (
                    <h3>
                      <Link href={card.link}>{card.heading}</Link>
                    </h3>
                  ) : (
                    <h3>{card.heading}</h3>
                  )}
                  <p className="league-summary__value">{card.value}</p>
                  {card.meta ? <p className="league-summary__meta">{card.meta}</p> : null}
                  {card.secondary ? <p className="league-summary__meta">{card.secondary}</p> : null}
                  {card.extra ? <p className="league-summary__meta">{card.extra}</p> : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <div className="matrix-wrapper">
          <table className="sim-matrix">
            <WeekHeader weeks={weeks} />
            <tbody>
              {teamContexts.map(({ team, standing, schedule, monteCarlo: monteCarloEntry }) => (
                <TeamRow
                  key={team.team_id}
                  team={team}
                  record={standing?.projected_record ?? { wins: 0, losses: 0, ties: 0 }}
                  weeks={weeks}
                  schedule={schedule}
                  monteCarlo={monteCarloEntry}
                />
              ))}
            </tbody>
          </table>
        </div>
        <footer className="legend">
          <span>
            <span className="legend__swatch legend__swatch--favorable" /> Favorable (&gt;60% win odds)
          </span>
          <span>
            <span className="legend__swatch legend__swatch--coinflip" /> Tight contest (40–60%)
          </span>
          <span>
            <span className="legend__swatch legend__swatch--underdog" /> Underdog (&lt;40% win odds)
          </span>
        </footer>
      </section>
    </main>
  );
}
