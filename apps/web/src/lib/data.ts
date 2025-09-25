import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

import { espnOutRoot, seasonDir } from "./paths";

export type TeamInfo = {
  team_id: number;
  name: string;
  abbrev: string | null;
  owners: string[];
  logo_url: string | null;
};

export type PlayerPerformance = {
  team_id: number;
  player_name: string;
  fantasy_points: number;
  lineup_slot: string;
  counts_for_score: boolean;
  espn_position: string;
};

export type TeamWeekSummary = {
  team: TeamInfo;
  total_points: number;
  bench_points: number;
  top_player: PlayerPerformance | null;
  all_players: PlayerPerformance[];
};

export type MatchupSummary = {
  matchup_id: string;
  home: TeamWeekSummary | null;
  away: TeamWeekSummary | null;
  season: number;
  week: number;
  winner: string | null;
};

export type WeekSnapshot = {
  season: number;
  week: number;
  matchups: MatchupSummary[];
  teamSummaries: TeamWeekSummary[];
  topPerformers: PlayerPerformance[];
};

type RawTeamRecord = {
  team_id: string;
  team_name: string;
  abbrev?: string;
  owners?: string;
  logo?: string;
};

type RawScheduleRecord = {
  matchup_id: string;
  matchup_period_id: string;
  home_team_id?: string;
  away_team_id?: string;
  winner?: string;
};

type RawWeeklyRow = {
  team_id: string;
  player_name: string;
  fantasy_points?: string;
  score_total?: string;
  lineup_slot?: string;
  counts_for_score?: string;
  espn_position?: string;
};

const WEEKLY_FILE_REGEX = /^weekly_scores_(\d+)_week_(\d+)\.csv$/;

async function listSeasonDirectories(): Promise<number[]> {
  const entries = await fs.readdir(espnOutRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a);
}

async function detectLatestSeasonWeek(): Promise<{ season: number; week: number } | null> {
  const seasons = await listSeasonDirectories();
  for (const season of seasons) {
    const files = await fs.readdir(seasonDir(season)).catch(() => []);
    const weeks = files
      .map((file) => {
        const match = file.match(WEEKLY_FILE_REGEX);
        if (!match) {
          return null;
        }
        const [, , weekPart] = match;
        return Number(weekPart);
      })
      .filter((week): week is number => Number.isFinite(week));

    if (weeks.length > 0) {
      const maxWeek = weeks.sort((a, b) => b - a)[0];
      return { season, week: maxWeek };
    }
  }
  return null;
}

async function loadTeams(season: number): Promise<Map<number, TeamInfo>> {
  const teamsPath = path.join(seasonDir(season), "teams.csv");
  const csv = await fs.readFile(teamsPath, "utf-8").catch(() => "");
  if (!csv) {
    return new Map();
  }

  const raw = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as RawTeamRecord[];

  const teams = new Map<number, TeamInfo>();
  for (const row of raw) {
    const id = Number(row.team_id);
    if (!Number.isFinite(id)) {
      continue;
    }
    const owners = (row.owners || "")
      .split(";")
      .map((owner) => owner.trim())
      .filter(Boolean);
    teams.set(id, {
      team_id: id,
      name: row.team_name,
      abbrev: row.abbrev || null,
      owners,
      logo_url: row.logo || null,
    });
  }
  return teams;
}

async function loadWeeklyRows(season: number, week: number): Promise<RawWeeklyRow[]> {
  const weeklyPath = path.join(seasonDir(season), `weekly_scores_${season}_week_${week}.csv`);
  const csv = await fs.readFile(weeklyPath, "utf-8").catch(() => "");
  if (!csv) {
    return [];
  }

  return parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as RawWeeklyRow[];
}

async function loadSchedule(season: number, week: number): Promise<RawScheduleRecord[]> {
  const schedulePath = path.join(seasonDir(season), "schedule.csv");
  const csv = await fs.readFile(schedulePath, "utf-8").catch(() => "");
  if (!csv) {
    return [];
  }

  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as RawScheduleRecord[];

  return rows.filter((row) => Number(row.matchup_period_id) === week);
}

function buildTeamSummaries(
  teams: Map<number, TeamInfo>,
  weeklyRows: RawWeeklyRow[],
): Map<number, TeamWeekSummary> {
  const summaries = new Map<number, TeamWeekSummary>();

  for (const row of weeklyRows) {
    const teamId = Number(row.team_id);
    if (!Number.isFinite(teamId)) {
      continue;
    }
    const teamInfo = teams.get(teamId);
    if (!teamInfo) {
      continue;
    }

    const countsForScore = String(row.counts_for_score).toLowerCase() === "true";
    const pointsValue = Number(row.fantasy_points ?? row.score_total ?? 0) || 0;
    const performance: PlayerPerformance = {
      team_id: teamId,
      player_name: row.player_name,
      fantasy_points: Number(pointsValue.toFixed(2)),
      lineup_slot: row.lineup_slot || "",
      counts_for_score: countsForScore,
      espn_position: row.espn_position || "",
    };

    if (!summaries.has(teamId)) {
      summaries.set(teamId, {
        team: teamInfo,
        total_points: 0,
        bench_points: 0,
        top_player: performance,
        all_players: [],
      });
    }

    const summary = summaries.get(teamId)!;
    summary.all_players.push(performance);
    if (countsForScore) {
      summary.total_points += pointsValue;
    } else {
      summary.bench_points += pointsValue;
    }

    if (!summary.top_player || performance.fantasy_points > summary.top_player.fantasy_points) {
      summary.top_player = performance;
    }
  }

  // Round totals to 2 decimals for display consistency
  for (const summary of summaries.values()) {
    summary.total_points = Number(summary.total_points.toFixed(2));
    summary.bench_points = Number(summary.bench_points.toFixed(2));
  }

  return summaries;
}

function buildMatchups(
  schedule: RawScheduleRecord[],
  summaries: Map<number, TeamWeekSummary>,
  season: number,
  week: number,
): MatchupSummary[] {
  return schedule.map((row) => {
    const homeId = Number(row.home_team_id);
    const awayId = Number(row.away_team_id);
    return {
      matchup_id: row.matchup_id,
      home: Number.isFinite(homeId) ? summaries.get(homeId) ?? null : null,
      away: Number.isFinite(awayId) ? summaries.get(awayId) ?? null : null,
      season,
      week,
      winner: row.winner || null,
    };
  });
}

export async function getLatestWeekSnapshot(): Promise<WeekSnapshot | null> {
  const detected = await detectLatestSeasonWeek();
  if (!detected) {
    return null;
  }

  const { season, week } = detected;
  const teams = await loadTeams(season);
  if (teams.size === 0) {
    return null;
  }

  const weeklyRows = await loadWeeklyRows(season, week);
  if (weeklyRows.length === 0) {
    return null;
  }

  const summariesMap = buildTeamSummaries(teams, weeklyRows);
  const schedule = await loadSchedule(season, week);
  const matchups = buildMatchups(schedule, summariesMap, season, week);

  const teamSummaries = Array.from(summariesMap.values()).sort(
    (a, b) => b.total_points - a.total_points,
  );

  const topPerformers = weeklyRows
    .map((row) => ({
      team_id: Number(row.team_id),
      player_name: row.player_name,
      fantasy_points: Number(row.fantasy_points ?? row.score_total ?? 0) || 0,
      lineup_slot: row.lineup_slot || "",
      counts_for_score: String(row.counts_for_score).toLowerCase() === "true",
      espn_position: row.espn_position || "",
    }))
    .filter((performance) => performance.counts_for_score)
    .sort((a, b) => b.fantasy_points - a.fantasy_points)
    .slice(0, 12);

  return {
    season,
    week,
    matchups,
    teamSummaries,
    topPerformers,
  };
}
