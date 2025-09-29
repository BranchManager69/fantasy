import { promises as fs } from "node:fs";
import path from "node:path";

import { getDataRoot } from "@/lib/paths";
import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";
import { getMatchupById, loadSimulation } from "@/lib/simulator-data";
import { loadOverlay } from "@/server/scenario-service";
import type {
  MatchupDetailResponse,
  MatchupPlayerLine,
  MatchupTeamSnapshot,
  MatchupTeamSummary,
} from "@/types/matchup-detail";

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

function parseNumber(value: string | null | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeLineupSlot(slot: string | null | undefined): string {
  if (!slot) return "";
  if (slot.toUpperCase() === "TOTAL") return "TOTAL";
  return slot.toUpperCase();
}

type WeeklyScorePlayers = {
  starters: MatchupPlayerLine[];
  bench: MatchupPlayerLine[];
};

const weeklyScoresCache = new Map<string, Map<number, WeeklyScorePlayers>>();

async function readWeeklyScores(season: number, week: number): Promise<Map<number, WeeklyScorePlayers> | null> {
  const cacheKey = `${season}-${week}`;
  if (weeklyScoresCache.has(cacheKey)) {
    return weeklyScoresCache.get(cacheKey)!;
  }

  const filePath = path.join(
    getDataRoot(),
    "out",
    "espn",
    String(season),
    `weekly_scores_${season}_week_${week}.csv`,
  );

  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const lines = contents.trim().split(/\r?\n/);
  if (lines.length <= 1) {
    const empty = new Map<number, WeeklyScorePlayers>();
    weeklyScoresCache.set(cacheKey, empty);
    return empty;
  }

  const headers = lines[0].split(",").map((value) => value.trim());
  const data = new Map<number, WeeklyScorePlayers>();

  for (let i = 1; i < lines.length; i += 1) {
    const row = lines[i].split(",");
    if (row.length !== headers.length) continue;

    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (row[index] ?? "").trim();
    });

    const teamId = parseNumber(record.team_id);
    if (teamId === null) continue;

    const lineupSlot = sanitizeLineupSlot(record.lineup_slot);
    if (lineupSlot === "TOTAL") {
      continue;
    }

    const countsForScore = record.counts_for_score?.toLowerCase() === "true";

    const player: MatchupPlayerLine = {
      espnPlayerId: parseNumber(record.espn_player_id),
      playerName: record.player_name || "Unknown Player",
      lineupSlot,
      position: record.espn_position || null,
      points: parseNumber(record.score_total) ?? 0,
      scoreBase: parseNumber(record.score_base),
      scoreBonus: parseNumber(record.score_bonus),
      scorePosition: parseNumber(record.score_position),
      countsForScore,
    };

    if (!data.has(teamId)) {
      data.set(teamId, { starters: [], bench: [] });
    }

    const bucket = countsForScore ? data.get(teamId)!.starters : data.get(teamId)!.bench;
    bucket.push(player);
  }

  for (const weekly of data.values()) {
    weekly.starters.sort((a, b) => {
      const rankDiff = slotRank(a.lineupSlot) - slotRank(b.lineupSlot);
      if (rankDiff !== 0) return rankDiff;
      const pointDiff = (b.points ?? 0) - (a.points ?? 0);
      if (pointDiff !== 0) return pointDiff;
      return a.playerName.localeCompare(b.playerName);
    });
    weekly.bench.sort((a, b) => {
      const rankDiff = slotRank(a.lineupSlot) - slotRank(b.lineupSlot);
      if (rankDiff !== 0) return rankDiff;
      const pointDiff = (b.points ?? 0) - (a.points ?? 0);
      if (pointDiff !== 0) return pointDiff;
      return a.playerName.localeCompare(b.playerName);
    });
  }

  weeklyScoresCache.set(cacheKey, data);
  return data;
}

function sortPlayers(players: MatchupPlayerLine[]): MatchupPlayerLine[] {
  return [...players].sort((a, b) => {
    const rankDiff = slotRank(a.lineupSlot) - slotRank(b.lineupSlot);
    if (rankDiff !== 0) return rankDiff;
    const pointDiff = (b.points ?? 0) - (a.points ?? 0);
    if (pointDiff !== 0) return pointDiff;
    return a.playerName.localeCompare(b.playerName);
  });
}

function overlayEntriesToPlayers(entries: any[]): WeeklyScorePlayers {
  const result: WeeklyScorePlayers = { starters: [], bench: [] };
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const lineupSlot = sanitizeLineupSlot(typeof raw.lineup_slot === "string" ? raw.lineup_slot : "");
    if (lineupSlot === "TOTAL") continue;
    const countsForScore = raw.counts_for_score !== false;
    const points =
      parseNumber(raw.score_total) ??
      (raw.projected_points !== undefined ? parseNumber(String(raw.projected_points)) : null) ??
      0;
    const player: MatchupPlayerLine = {
      espnPlayerId: parseNumber(raw.espn_player_id),
      playerName: typeof raw.player_name === "string" ? raw.player_name : "Scenario Override",
      lineupSlot,
      position: typeof raw.espn_position === "string" && raw.espn_position.length > 0 ? raw.espn_position : null,
      points,
      scoreBase: parseNumber(raw.score_base),
      scoreBonus: parseNumber(raw.score_bonus),
      scorePosition: parseNumber(raw.score_position),
      countsForScore,
    };
    const bucket = countsForScore ? result.starters : result.bench;
    bucket.push(player);
  }
  result.starters = sortPlayers(result.starters);
  result.bench = sortPlayers(result.bench);
  return result;
}

function mapSimulationPlayers(players: any[] | undefined): MatchupPlayerLine[] {
  if (!players) return [];
  return players.map((player) => ({
    espnPlayerId: typeof player.espn_player_id === "number" ? player.espn_player_id : null,
    playerName: player.player_name ?? "Player",
    lineupSlot: sanitizeLineupSlot(player.lineup_slot),
    position: player.espn_position ?? null,
    points: typeof player.projected_points === "number" ? player.projected_points : 0,
    scoreBase: null,
    scoreBonus: null,
    scorePosition: null,
    countsForScore: Boolean(player.counts_for_score ?? true),
  }));
}

function buildTeamSummary(team: any): MatchupTeamSummary {
  return {
    teamId: team.team_id,
    name: team.name,
    abbrev: team.abbrev ?? null,
    owners: team.owners ?? [],
    logoUrl: team.logo_url ?? null,
  };
}

export async function getMatchupDetail(
  season: number,
  matchupId: string,
  scenarioId?: string | null,
): Promise<MatchupDetailResponse | null> {
  const scenario = scenarioId && scenarioId.trim().length > 0 ? scenarioId.trim() : BASELINE_SCENARIO_ID;
  const simulation = await loadSimulation(season, scenario);
  if (!simulation) {
    return null;
  }

  const matchup = getMatchupById(simulation, matchupId);
  if (!matchup) {
    return null;
  }
  const resolvedMatchup = matchup;

  const overlay =
    scenario !== BASELINE_SCENARIO_ID ? await loadOverlay(season, scenario).catch(() => null) : null;
  let overlayWeekEntries: Record<string, any> | null = null;
  if (overlay && overlay.completed_weeks && typeof overlay.completed_weeks === "object") {
    const weekPayload = (overlay.completed_weeks as Record<string, any>)[String(resolvedMatchup.week)];
    if (weekPayload && typeof weekPayload === "object" && weekPayload.teams) {
      overlayWeekEntries = weekPayload.teams as Record<string, any>;
    }
  }

  let weeklyScores: Map<number, WeeklyScorePlayers> | null = null;
  if (resolvedMatchup.is_actual) {
    weeklyScores = await readWeeklyScores(season, resolvedMatchup.week);
  }

  function buildTeamSnapshot(side: "home" | "away"): MatchupTeamSnapshot {
    const team = resolvedMatchup[side];
    const opponent = resolvedMatchup[side === "home" ? "away" : "home"];
    const summary = buildTeamSummary(team.team);

    let actualPlayers: WeeklyScorePlayers | null = null;
    if (overlayWeekEntries) {
      const override = overlayWeekEntries[String(summary.teamId)] ?? overlayWeekEntries[summary.teamId];
      if (override && typeof override === "object" && Array.isArray(override.entries)) {
        actualPlayers = overlayEntriesToPlayers(override.entries);
      }
    }

    if (!actualPlayers && weeklyScores && weeklyScores.has(summary.teamId)) {
      actualPlayers = weeklyScores.get(summary.teamId)!;
    }

    const projectedStarters = sortPlayers(mapSimulationPlayers(team.starters));
    const projectedBench = sortPlayers(mapSimulationPlayers(team.bench));

    return {
      summary,
      projectedPoints: typeof team.projected_points === "number" ? team.projected_points : null,
      opponentProjectedPoints: typeof opponent.projected_points === "number" ? opponent.projected_points : null,
      finalPoints: resolvedMatchup.final_score ? (resolvedMatchup.final_score[side] ?? null) : null,
      players: {
        actual: actualPlayers,
        projected: {
          starters: projectedStarters,
          bench: projectedBench,
        },
      },
    };
  }

  const home = buildTeamSnapshot("home");
  const away = buildTeamSnapshot("away");

  const finalMargin = home.finalPoints !== null && away.finalPoints !== null
    ? home.finalPoints - away.finalPoints
    : null;

  const matchupStatusRaw = typeof resolvedMatchup.status === "string" ? resolvedMatchup.status : null;
  const matchupStatus = (() => {
    if (matchupStatusRaw === "in_progress" || matchupStatusRaw === "final") {
      return matchupStatusRaw;
    }
    return resolvedMatchup.is_actual ? "final" : "upcoming";
  })();

  return {
    season,
    scenarioId: scenario,
    matchupId,
    week: resolvedMatchup.week,
    status: matchupStatus,
    home,
    away,
    projectionMargin: typeof resolvedMatchup.projected_margin === "number" ? resolvedMatchup.projected_margin : null,
    finalMargin,
    winProbabilities: {
      home:
        typeof resolvedMatchup.home_win_probability === "number"
          ? resolvedMatchup.home_win_probability
          : null,
      away:
        typeof resolvedMatchup.away_win_probability === "number"
          ? resolvedMatchup.away_win_probability
          : null,
    },
  };
}
