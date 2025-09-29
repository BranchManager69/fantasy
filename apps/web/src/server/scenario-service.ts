import { promises as fs } from "node:fs";
import path from "node:path";

import { getDataRoot } from "@/lib/paths";
import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";
import { listScenarios } from "@/lib/scenario-data";
import { loadSimulation, type RestOfSeasonSimulation, type SimulationWeekMatchup } from "@/lib/simulator-data";
import type {
  CompletedWeekDiff,
  ProjectionWeekDiffEntry,
  ScenarioDetailResponse,
  ScenarioDiffSide,
  ScenarioDiffSummary,
  ScenarioOption,
  ScenarioOverlay,
} from "@/types/scenario";

const overlaysRoot = path.join(getDataRoot(), "overlays");

export async function loadOverlay(season: number, scenarioId: string): Promise<ScenarioOverlay | null> {
  const seasonDir = path.join(overlaysRoot, String(season));
  const candidates = [
    path.join(seasonDir, `${scenarioId}.json`),
    path.join(seasonDir, `${scenarioId}.scenario.json`),
  ];

  for (const candidate of candidates) {
    try {
      const contents = await fs.readFile(candidate, "utf-8");
      const parsed = JSON.parse(contents) as ScenarioOverlay;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      // Malformed JSON or other error – treat as missing but log? For now skip silently.
    }
  }

  return null;
}

function matchupMap(
  simulation: RestOfSeasonSimulation,
  predicate: (matchup: SimulationWeekMatchup) => boolean,
): Map<number, Map<string, SimulationWeekMatchup>> {
  const weeks = new Map<number, Map<string, SimulationWeekMatchup>>();
  for (const week of simulation.weeks) {
    for (const matchup of week.matchups) {
      if (!predicate(matchup)) continue;
      if (!weeks.has(matchup.week)) {
        weeks.set(matchup.week, new Map());
      }
      weeks.get(matchup.week)!.set(matchup.matchup_id, matchup);
    }
  }
  return weeks;
}

function winnerFromResult(matchup: SimulationWeekMatchup | undefined | null): "home" | "away" | "tie" | null {
  if (!matchup?.result) return null;
  const { result } = matchup;
  if (result.home === "win") return "home";
  if (result.home === "loss") return "away";
  if (result.home === "tie") return "tie";
  return null;
}

function scoreFromFinal(matchup: SimulationWeekMatchup | undefined | null, side: "home" | "away"): number | null {
  if (!matchup?.final_score) return null;
  const value = matchup.final_score[side];
  return typeof value === "number" ? value : null;
}

function projectedFromMatch(matchup: SimulationWeekMatchup | undefined | null, side: "home" | "away"): number | null {
  if (!matchup) return null;
  const team = matchup[side];
  const value = typeof team.projected_points === "number" ? team.projected_points : null;
  return value;
}

function toDiffSide(
  scenarioMatch: SimulationWeekMatchup,
  baselineMatch: SimulationWeekMatchup | undefined,
  side: "home" | "away",
  valueExtractor: (matchup: SimulationWeekMatchup | undefined, s: "home" | "away") => number | null,
): ScenarioDiffSide {
  const team = scenarioMatch[side].team;
  const scenarioValue = valueExtractor(scenarioMatch, side);
  const baselineValue = valueExtractor(baselineMatch, side);
  const delta =
    scenarioValue !== null && baselineValue !== null ? Number((scenarioValue - baselineValue).toFixed(3)) : null;
  return {
    teamId: team.team_id,
    teamName: team.name,
    baselineScore: baselineValue,
    scenarioScore: scenarioValue,
    delta,
  };
}

function meaningfulDelta(diff: ScenarioDiffSide): boolean {
  if (diff.delta === null) {
    // If either value missing but not both, consider it meaningful.
    if (diff.baselineScore === null && diff.scenarioScore === null) return false;
    return diff.baselineScore !== diff.scenarioScore;
  }
  return Math.abs(diff.delta) >= 0.05;
}

function buildCompletedWeekDiff(
  baseline: RestOfSeasonSimulation,
  scenario: RestOfSeasonSimulation,
): CompletedWeekDiff[] {
  const baselineMap = matchupMap(baseline, (matchup) => Boolean(matchup.is_actual));
  const scenarioMap = matchupMap(scenario, (matchup) => Boolean(matchup.is_actual));
  const rows: CompletedWeekDiff[] = [];

  for (const [week, matchups] of scenarioMap.entries()) {
    for (const [matchupId, scenarioMatch] of matchups.entries()) {
      const baselineMatch = baselineMap.get(week)?.get(matchupId);
      const home = toDiffSide(scenarioMatch, baselineMatch, "home", scoreFromFinal);
      const away = toDiffSide(scenarioMatch, baselineMatch, "away", scoreFromFinal);
      const winnerBaseline = winnerFromResult(baselineMatch);
      const winnerScenario = winnerFromResult(scenarioMatch);
      const changedWinner = winnerBaseline !== winnerScenario;
      const hasMeaningfulChange = changedWinner || meaningfulDelta(home) || meaningfulDelta(away);
      if (!hasMeaningfulChange) {
        continue;
      }
      rows.push({
        week,
        matchupId,
        home,
        away,
        winner: {
          baseline: winnerBaseline,
          scenario: winnerScenario,
        },
      });
    }
  }

  rows.sort((a, b) => (a.week === b.week ? a.matchupId.localeCompare(b.matchupId) : a.week - b.week));
  return rows;
}

function buildProjectionWeekDiff(
  baseline: RestOfSeasonSimulation,
  scenario: RestOfSeasonSimulation,
): ProjectionWeekDiffEntry[] {
  const baselineMap = matchupMap(baseline, (matchup) => !matchup.is_actual);
  const scenarioMap = matchupMap(scenario, (matchup) => !matchup.is_actual);
  const rows: ProjectionWeekDiffEntry[] = [];

  for (const [week, matchups] of scenarioMap.entries()) {
    for (const [matchupId, scenarioMatch] of matchups.entries()) {
      const baselineMatch = baselineMap.get(week)?.get(matchupId);
      const home = toDiffSide(scenarioMatch, baselineMatch, "home", projectedFromMatch);
      const away = toDiffSide(scenarioMatch, baselineMatch, "away", projectedFromMatch);
      const hasMeaningfulChange = meaningfulDelta(home) || meaningfulDelta(away);
      if (!hasMeaningfulChange) {
        continue;
      }
      rows.push({
        week,
        matchupId,
        home,
        away,
      });
    }
  }

  rows.sort((a, b) => (a.week === b.week ? a.matchupId.localeCompare(b.matchupId) : a.week - b.week));
  return rows;
}

function buildDiffSummary(
  baseline: RestOfSeasonSimulation | null,
  scenario: RestOfSeasonSimulation | null,
): ScenarioDiffSummary {
  if (!baseline || !scenario) {
    return { completedWeeks: [], projectionWeeks: [] };
  }
  return {
    completedWeeks: buildCompletedWeekDiff(baseline, scenario),
    projectionWeeks: buildProjectionWeekDiff(baseline, scenario),
  };
}

export async function getScenarioList(season: number): Promise<ScenarioOption[]> {
  const scenarios = await listScenarios(season);
  return scenarios;
}

export async function getScenarioDetail(
  season: number,
  scenarioId: string,
): Promise<ScenarioDetailResponse | null> {
  const scenarios = await getScenarioList(season);
  const scenario = scenarios.find((item) => item.id === scenarioId);
  if (!scenario) {
    return null;
  }

  const overlay = scenario.isBaseline ? null : await loadOverlay(season, scenarioId);
  const baselineSimulation = await loadSimulation(season, BASELINE_SCENARIO_ID);
  const scenarioSimulation = scenario.isBaseline
    ? baselineSimulation
    : await loadSimulation(season, scenarioId);

  const diff = buildDiffSummary(baselineSimulation, scenarioSimulation);
  const hasSimulation = Boolean(scenarioSimulation);
  const simulationGeneratedAt = scenarioSimulation?.generated_at ?? null;

  return {
    scenario,
    overlay,
    hasSimulation,
    simulationGeneratedAt,
    diff,
  };
}
