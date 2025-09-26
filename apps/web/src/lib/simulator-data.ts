import { promises as fs } from "node:fs";
import path from "node:path";

import { simulationSeasonDir, simulationsOutRoot } from "@/lib/paths";

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

export type SimulationWeek = {
  week: number;
  matchups: SimulationMatchup[];
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
  };
  monte_carlo?: MonteCarloSummary;
};

async function listSimulationSeasons(): Promise<number[]> {
  const entries = await fs.readdir(simulationsOutRoot, { withFileTypes: true }).catch(() => []);
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

export async function loadSimulation(season: number): Promise<RestOfSeasonSimulation | null> {
  const seasonPath = simulationSeasonDir(season);
  const filePath = path.join(seasonPath, "rest_of_season.json");
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  return readSimulationFile(filePath);
}

export async function getLatestSimulation(): Promise<RestOfSeasonSimulation | null> {
  const seasons = await listSimulationSeasons();
  for (const season of seasons) {
    const dataset = await loadSimulation(season);
    if (dataset) {
      return dataset;
    }
  }
  return null;
}
