import { AppNav } from "@/components/app-nav";
import { HighlightCards, buildHighlightCards } from "@/components/simulation/highlight-cards";
import { SimulationHeader } from "@/components/simulation/simulation-header";
import { SimulationLegend } from "@/components/simulation/simulation-legend";
import { SimulationMatrix } from "@/components/simulation/simulation-matrix";
import type { SimulationTeamContext } from "@/components/simulation/types";
import { LiveActivityFeed } from "@/components/live-activity-feed";
import { PowerRankings, type PowerRankingEntry } from "@/components/power-rankings";
import { ScenarioDrawer } from "@/components/scenario-drawer";
import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";
import { listScenarios } from "@/lib/scenario-data";
import { normalizeScenarioId, type ScenarioSearchParam } from "@/lib/scenario-utils";
import {
  buildSimulationLookup,
  getLatestSimulation,
  getPreviousSimulationSnapshot,
  getTeamSchedule,
  type SimulationLookup,
  type RestOfSeasonSimulation,
} from "@/lib/simulator-data";
import { computeTeamMetrics } from "@/lib/team-metrics";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
        <AppNav />
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
  const previousSimulation = await getPreviousSimulationSnapshot(simulation, activeScenarioId);
  const previousLookup = previousSimulation ? buildSimulationLookup(previousSimulation) : null;
  const deltaContext = previousSimulation && previousLookup
    ? {
        simulation: previousSimulation,
        lookup: previousLookup,
      }
    : undefined;
  const weeks = [...new Set(simulation.weeks.map((week) => week.week))].sort((a, b) => a - b);
  const firstWeek = weeks[0] ?? simulation.start_week;
  const lastWeek = weeks[weeks.length - 1] ?? simulation.end_week;

  const teamContexts = buildTeamContexts(simulation, lookup, deltaContext);
  const scenarios = await listScenarios(simulation.season);
  const currentWeek = findCurrentWeek(teamContexts, weeks);
  const futureWeeks = weeks.filter((week) => week > currentWeek);
  const powerRankings = buildPowerRankings(teamContexts, futureWeeks);
  const highlightCards = buildHighlightCards(teamContexts);

  return (
    <main className="shell">
      <AppNav />
      <section className="panel matrix-panel">
        <SimulationHeader
          season={simulation.season}
          firstWeek={firstWeek}
          lastWeek={lastWeek}
          weeksCount={simulation.weeks.length}
          teamCount={simulation.teams.length}
          monteCarlo={simulation.monte_carlo}
          generatedAt={simulation.generated_at}
          scenarios={scenarios}
          activeScenarioId={activeScenarioId}
        />

        <ScenarioDrawer
          season={simulation.season}
          scenarios={scenarios}
          activeScenarioId={activeScenarioId}
        />

        <LiveActivityFeed scenarioId={activeScenarioId} />

        <HighlightCards cards={highlightCards} />

        <PowerRankings rankings={powerRankings} />

        <SimulationMatrix weeks={weeks} teamContexts={teamContexts} />

        <SimulationLegend />
      </section>
    </main>
  );
}

function buildTeamContexts(
  simulation: RestOfSeasonSimulation,
  lookup = buildSimulationLookup(simulation),
  deltaContext?: {
    simulation: RestOfSeasonSimulation;
    lookup: SimulationLookup;
  },
): SimulationTeamContext[] {
  return simulation.standings.map((entry) => {
    const team = entry.team;
    const schedule = getTeamSchedule(simulation, team.team_id, lookup, deltaContext);
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
}

function findCurrentWeek(teamContexts: SimulationTeamContext[], weeks: number[]): number {
  const completedWeeks = weeks.filter((week) =>
    teamContexts.some((context) =>
      context.schedule.some((game) => game.week === week && game.isActual === true),
    ),
  );
  if (completedWeeks.length === 0) {
    return 0;
  }
  return Math.max(...completedWeeks);
}

function buildPowerRankings(
  teamContexts: SimulationTeamContext[],
  futureWeeks: number[],
): PowerRankingEntry[] {
  return teamContexts
    .map((context) => {
      const futureGames = context.schedule.filter((game) => futureWeeks.includes(game.week));
      const totalProjectedPoints = futureGames.reduce((sum, game) => sum + game.projected_points, 0);
      const avgPPG = futureGames.length > 0 ? totalProjectedPoints / futureGames.length : 0;

      return {
        rank: 0,
        team: context.team,
        projectedPPG: avgPPG,
      };
    })
    .sort((a, b) => b.projectedPPG - a.projectedPPG)
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));
}
