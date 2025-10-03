import { promises as fs } from "node:fs";
import path from "node:path";

import { simulationSeasonDir, getSimulationsOutRoot, simulationHistorySeasonDir } from "@/lib/paths";
import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";

export type SimulationPlayer = {
  espn_player_id: number | null;
  player_name: string;
  lineup_slot: string;
  espn_position: string;
  projected_points: number;
  counts_for_score: boolean;
};

export type SimulationTeamMeta = {
  team_id: number;
  name: string;
  abbrev: string | null;
  owners: string[];
  logo_url: string | null;
};

export type SimulationTeamProjection = {
  team: SimulationTeamMeta;
  projected_points: number;
  starters: SimulationPlayer[];
  bench: SimulationPlayer[];
};

export type SimulationMatchup = {
  matchup_id: string;
  week: number;
  home: SimulationTeamProjection;
  away: SimulationTeamProjection;
  favorite_team_id: number | null;
  projected_margin: number;
  home_win_probability: number;
  away_win_probability: number;
};

export type SimulationWeekMatchup = SimulationMatchup & {
  is_actual?: boolean;
  result?: {
    home: "win" | "loss" | "tie";
    away: "win" | "loss" | "tie";
  };
  final_score?: {
    home: number;
    away: number;
  };
  status?: "final" | "in_progress" | "scheduled";
};

export type SimulationWeek = {
  week: number;
  matchups: SimulationWeekMatchup[];
};

export type SimulationTeamScheduleEntry = {
  week: number;
  matchup_id: string;
  opponent_team_id: number;
  is_home: boolean;
  projected_points: number;
  opponent_projected_points: number;
  win_probability: number;
  projected_margin: number;
  is_actual?: boolean;
  result?: "win" | "loss" | "tie";
  actual_points?: number;
  opponent_actual_points?: number;
  status?: "final" | "in_progress" | "scheduled";
};

export type SimulationStanding = {
  team: SimulationTeamMeta;
  projected_record: {
    wins: number;
    losses: number;
    ties: number;
  };
  projected_points: number;
  average_projected_points: number;
  games_remaining: number;
};

export type MonteCarloTeamSummary = {
  team: SimulationTeamMeta;
  average_wins: number;
  average_losses: number;
  average_points: number;
  games_remaining: number;
  playoff_odds: number;
  top_seed_odds: number;
  seed_distribution: Record<string, number>;
  best_seed: number | null;
  worst_seed: number | null;
  median_seed: number | null;
};

export type MonteCarloSummary = {
  iterations: number;
  playoff_slots: number;
  random_seed: number | null;
  teams: MonteCarloTeamSummary[];
};

export type RestOfSeasonSimulation = {
  season: number;
  generated_at: string;
  start_week: number;
  end_week: number;
  projection_sigma: number;
  teams: SimulationTeamMeta[];
  team_schedule: Record<string, SimulationTeamScheduleEntry[]>;
  weeks: SimulationWeek[];
  standings: SimulationStanding[];
  sources: {
    projections_weeks: number[];
    completed_weeks?: number[];
    scenario_id?: string;
  };
  completed_weeks?: number[];
  monte_carlo?: MonteCarloSummary;
  scenario?: {
    id: string;
    label: string;
    season: number;
    is_baseline: boolean;
    overrides?: {
      completed_weeks: number[];
      projection_weeks: number[];
    };
    description?: string;
    updated_at?: string;
  };
};

const SCENARIO_FILENAME_SAFE = /[^a-z0-9_-]+/g;

function scenarioSlug(id: string): string {
  const slug = id.toLowerCase().replace(SCENARIO_FILENAME_SAFE, "-").replace(/(^-|-$)+/g, "");
  return slug || "scenario";
}

function scenarioFilename(scenarioId?: string): string {
  if (!scenarioId || scenarioId === BASELINE_SCENARIO_ID) {
    return "rest_of_season.json";
  }
  return `rest_of_season__scenario-${scenarioSlug(scenarioId)}.json`;
}

function scenarioIdentifier(simulation: RestOfSeasonSimulation): string {
  return simulation.scenario?.id ?? BASELINE_SCENARIO_ID;
}

function normalizeHistoryTimestamp(raw: string): string {
  return raw.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, (_, hh, mm, ss, ms) => `T${hh}:${mm}:${ss}.${ms}Z`);
}

function parseHistoryTimestamp(raw: string): number | null {
  const normalized = normalizeHistoryTimestamp(raw);
  const value = Date.parse(normalized);
  return Number.isNaN(value) ? null : value;
}

const DEFAULT_DELTA_MAX_AGE_MS = 15 * 60 * 1000;

type ScheduleDeltaContext = {
  simulation: RestOfSeasonSimulation;
  lookup: SimulationLookup;
  maxAgeMs?: number;
};

async function listSimulationSeasons(): Promise<number[]> {
  const simRoot = getSimulationsOutRoot();
  const entries = await fs.readdir(simRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((season) => Number.isFinite(season))
    .sort((a, b) => b - a);
}

async function readSimulationFile(filePath: string): Promise<RestOfSeasonSimulation | null> {
  try {
    const contents = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(contents) as RestOfSeasonSimulation;
    return parsed;
  } catch {
    return null;
  }
}

export async function loadSimulation(
  season: number,
  scenarioId?: string,
): Promise<RestOfSeasonSimulation | null> {
  const seasonPath = simulationSeasonDir(season);
  const filePath = path.join(seasonPath, scenarioFilename(scenarioId));
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  return readSimulationFile(filePath);
}

export async function getLatestSimulation(
  scenarioId?: string,
): Promise<RestOfSeasonSimulation | null> {
  const seasons = await listSimulationSeasons();
  for (const season of seasons) {
    const dataset = await loadSimulation(season, scenarioId);
    if (dataset) {
      return dataset;
    }
  }
  return null;
}

export async function getPreviousSimulationSnapshot(
  simulation: RestOfSeasonSimulation,
  scenarioId?: string,
): Promise<RestOfSeasonSimulation | null> {
  const historyDir = simulationHistorySeasonDir(simulation.season);
  const baseName = scenarioFilename(scenarioId).replace(/\.json$/i, "");
  let entries: string[];
  try {
    entries = await fs.readdir(historyDir);
  } catch {
    return null;
  }

  const prefix = `${baseName}__`;
  const candidates = entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => {
      const stamp = name.slice(prefix.length, -5);
      const timestamp = parseHistoryTimestamp(stamp);
      return { name, timestamp } as const;
    })
    .filter((entry): entry is { name: string; timestamp: number } => entry.timestamp !== null)
    .sort((a, b) => b.timestamp - a.timestamp);

  const targetScenario = scenarioIdentifier(simulation);

  for (const candidate of candidates) {
    const filePath = path.join(historyDir, candidate.name);
    const dataset = await readSimulationFile(filePath);
    if (!dataset) {
      continue;
    }
    if (dataset.generated_at === simulation.generated_at) {
      continue;
    }
    if (scenarioIdentifier(dataset) !== targetScenario) {
      continue;
    }
    return dataset;
  }

  return null;
}

export type SimulationLookup = {
  teamsById: Map<number, SimulationTeamMeta>;
  standingsByTeamId: Map<number, SimulationStanding>;
  scheduleByTeamId: Map<number, SimulationTeamScheduleEntry[]>;
  matchupsById: Map<string, SimulationMatchupWithWeek>;
  monteCarloByTeamId: Map<number, MonteCarloTeamSummary>;
};

export type SimulationMatchupWithWeek = SimulationWeekMatchup & { week: number };

export type TeamScheduleWithContext = Omit<
  SimulationTeamScheduleEntry,
  "is_actual" | "actual_points" | "opponent_actual_points" | "result" | "status"
> & {
  opponent: SimulationTeamMeta | null;
  opponentStanding: SimulationStanding | null;
  opponentMonteCarlo: MonteCarloTeamSummary | null;
  matchup: SimulationMatchupWithWeek | null;
  teamProjection: SimulationTeamProjection | null;
  opponentProjection: SimulationTeamProjection | null;
  isActual: boolean;
  result: "win" | "loss" | "tie" | null;
  actualPoints: number | null;
  opponentActualPoints: number | null;
  status: "final" | "in_progress" | "scheduled" | "upcoming" | null;
  winProbabilityDelta?: number | null;
};

export type TeamContext = {
  team: SimulationTeamMeta;
  standing: SimulationStanding | null;
  monteCarlo: MonteCarloTeamSummary | null;
  schedule: TeamScheduleWithContext[];
  nextMatchup: TeamScheduleWithContext | null;
};

export function buildSimulationLookup(simulation: RestOfSeasonSimulation): SimulationLookup {
  const teamsById = new Map<number, SimulationTeamMeta>();
  for (const team of simulation.teams) {
    teamsById.set(team.team_id, team);
  }

  const standingsByTeamId = new Map<number, SimulationStanding>();
  for (const standing of simulation.standings) {
    standingsByTeamId.set(standing.team.team_id, standing);
  }

  const scheduleByTeamId = new Map<number, SimulationTeamScheduleEntry[]>();
  for (const [teamIdRaw, entries] of Object.entries(simulation.team_schedule)) {
    const teamId = Number(teamIdRaw);
    if (!Number.isFinite(teamId)) {
      continue;
    }
    const sorted = [...entries].sort((a, b) => a.week - b.week);
    scheduleByTeamId.set(teamId, sorted);
  }

  const matchupsById = new Map<string, SimulationMatchupWithWeek>();
  for (const week of simulation.weeks) {
    for (const matchup of week.matchups) {
      matchupsById.set(matchup.matchup_id, { ...matchup, week: week.week });
    }
  }

  const monteCarloByTeamId = new Map<number, MonteCarloTeamSummary>();
  if (simulation.monte_carlo) {
    for (const entry of simulation.monte_carlo.teams) {
      monteCarloByTeamId.set(entry.team.team_id, entry);
    }
  }

  return {
    teamsById,
    standingsByTeamId,
    scheduleByTeamId,
    matchupsById,
    monteCarloByTeamId,
  };
}

export function getMatchupById(
  simulation: RestOfSeasonSimulation,
  matchupId: string,
  lookup?: SimulationLookup,
): SimulationMatchupWithWeek | null {
  const context = lookup ?? buildSimulationLookup(simulation);
  return context.matchupsById.get(matchupId) ?? null;
}

export function getTeamSchedule(
  simulation: RestOfSeasonSimulation,
  teamId: number,
  lookup?: SimulationLookup,
  deltaContext?: ScheduleDeltaContext,
): TeamScheduleWithContext[] {
  const context = lookup ?? buildSimulationLookup(simulation);
  const schedule = context.scheduleByTeamId.get(teamId);
  if (!schedule) {
    return [];
  }

  let previousIndex: Map<string, SimulationTeamScheduleEntry> | null = null;
  if (deltaContext) {
    const sameScenario =
      scenarioIdentifier(simulation) === scenarioIdentifier(deltaContext.simulation);
    const currentGeneratedAt = Date.parse(simulation.generated_at);
    const previousGeneratedAt = Date.parse(deltaContext.simulation.generated_at);
    const maxAge = deltaContext.maxAgeMs ?? DEFAULT_DELTA_MAX_AGE_MS;
    const fresh =
      sameScenario &&
      Number.isFinite(currentGeneratedAt) &&
      Number.isFinite(previousGeneratedAt) &&
      currentGeneratedAt > previousGeneratedAt &&
      currentGeneratedAt - previousGeneratedAt <= maxAge;

    if (fresh) {
      const previousSchedule = deltaContext.lookup.scheduleByTeamId.get(teamId);
      if (previousSchedule) {
        previousIndex = new Map(
          previousSchedule.map((entry) => [
            `${entry.week}::${entry.matchup_id}::${entry.is_home ? 1 : 0}`,
            entry,
          ]),
        );
      }
    }
  }

  return schedule.map((entry) => {
    const {
      is_actual,
      result: rawResult,
      actual_points,
      opponent_actual_points,
      status,
      ...rest
    } = entry;
    const isActual = Boolean(is_actual);
    const result = (rawResult as "win" | "loss" | "tie" | undefined) ?? null;
    const actualPoints = isActual ? actual_points ?? entry.projected_points : null;
    const opponentActualPoints = isActual
      ? opponent_actual_points ?? entry.opponent_projected_points
      : null;
    const normalizedStatus: "final" | "in_progress" | "scheduled" | "upcoming" | null = (() => {
      if (typeof status === "string") {
        const lowered = status.toLowerCase();
        if (lowered === "final" || lowered === "in_progress" || lowered === "scheduled") {
          return lowered;
        }
      }
      if (isActual) {
        return result ? "final" : "in_progress";
      }
      return "upcoming";
    })();

    const matchup = context.matchupsById.get(entry.matchup_id) ?? null;
    const opponent = context.teamsById.get(entry.opponent_team_id) ?? null;
    const opponentStanding = context.standingsByTeamId.get(entry.opponent_team_id) ?? null;
    const opponentMonteCarlo = context.monteCarloByTeamId.get(entry.opponent_team_id) ?? null;

    let teamProjection: SimulationTeamProjection | null = null;
    let opponentProjection: SimulationTeamProjection | null = null;

    if (matchup) {
      if (entry.is_home) {
        teamProjection = matchup.home;
        opponentProjection = matchup.away;
      } else {
        teamProjection = matchup.away;
        opponentProjection = matchup.home;
      }
    }

    return {
      ...rest,
      opponent,
      opponentStanding: opponentStanding ?? null,
      opponentMonteCarlo: opponentMonteCarlo ?? null,
      matchup,
      teamProjection,
      opponentProjection,
      isActual,
      result,
      actualPoints,
      opponentActualPoints,
      status: normalizedStatus,
      winProbabilityDelta:
        previousIndex && normalizedStatus !== "scheduled"
          ? (() => {
              const key = `${entry.week}::${entry.matchup_id}::${entry.is_home ? 1 : 0}`;
              const previous = previousIndex.get(key);
              if (!previous) return null;
              const delta = (entry.win_probability - previous.win_probability) * 100;
              if (!Number.isFinite(delta)) return null;
              return delta;
            })()
          : null,
    };
  });
}

export function getTeamContext(
  simulation: RestOfSeasonSimulation,
  teamId: number,
  lookup?: SimulationLookup,
): TeamContext | null {
  const context = lookup ?? buildSimulationLookup(simulation);
  const team = context.teamsById.get(teamId);
  if (!team) {
    return null;
  }

  const schedule = getTeamSchedule(simulation, teamId, context);
  const standing = context.standingsByTeamId.get(teamId) ?? null;
  const monteCarlo = context.monteCarloByTeamId.get(teamId) ?? null;

  // Prefer an in-progress game if one exists; otherwise the earliest non-final game.
  // This ensures the team page shows the current week when it's underway,
  // instead of jumping to the simulation's start_week (which may point to the next projection week).
  const nextMatchup = (() => {
    const nonFinal = schedule.filter((entry) => entry.status !== "final");
    if (nonFinal.length === 0) {
      return null;
    }
    const live = nonFinal.find((entry) => entry.status === "in_progress");
    return live ?? nonFinal[0];
  })();

  return {
    team,
    standing,
    monteCarlo,
    schedule,
    nextMatchup,
  };
}

export function getTeamsSortedByStanding(
  simulation: RestOfSeasonSimulation,
  lookup?: SimulationLookup,
): SimulationStanding[] {
  const context = lookup ?? buildSimulationLookup(simulation);
  return simulation.standings
    .map((standing) => context.standingsByTeamId.get(standing.team.team_id) ?? standing)
    .sort((a, b) => b.projected_record.wins - a.projected_record.wins);
}
