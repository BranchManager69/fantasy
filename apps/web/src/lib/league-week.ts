import { promises as fs } from "node:fs";
import path from "node:path";
import { getDataRoot } from "@/lib/paths";

export type WeekPlayer = {
  id: number; name: string; position: string; slot: string; slotId: number;
  eligibleSlots: number[]; starter: boolean; points: number | null;
};
export type WeekTeam = {
  id: number; name: string; opponentId: number; opponentName: string; matchupId: number;
  score: number; opponentScore: number; result: string; final: boolean;
  players: WeekPlayer[]; lineupReconciled: boolean; starterTotal: number;
  allPlay: { wins: number; losses: number; ties: number } | null;
};
export type LeagueWeek = {
  season: number; week: number; leagueName: string; generatedAt: string;
  complete: boolean; currentWeek: number; sourceUrl: string; teams: WeekTeam[];
  matchups: { id: number; homeId: number; awayId: number; final: boolean }[];
};
export type WeekMoment = {
  id: string; player_name: string; team_id: number; nfl_game_id: string;
  quarter: number; clock: string; description: string; fantasy_points: number;
  note: string; source_url: string;
};
export type WeekMoments = {
  season: number; week: number; moments: WeekMoment[];
  lead?: {
    title: string; summary: string; team_id: number; player_name: string;
    quarter: number; clock: string; fantasy_points: number;
    before: Record<string, number>; after: Record<string, number>;
    source_url: string; method_note: string;
  };
};

async function readArtifact<T>(filename: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function loadLeagueWeek(season: number, week: number) {
  const directory = path.join(getDataRoot(), "out", "league", String(season));
  const [report, moments] = await Promise.all([
    readArtifact<LeagueWeek>(path.join(directory, `week_${week}.json`)),
    readArtifact<WeekMoments>(path.join(directory, `week_${week}_moments.json`)),
  ]);
  if (report && (report.season !== season || report.week !== week || !Array.isArray(report.teams))) {
    throw new Error("Weekly report does not match the requested season and week");
  }
  if (moments && (moments.season !== season || moments.week !== week || !Array.isArray(moments.moments))) {
    throw new Error("Play context does not match the requested season and week");
  }
  return { report, moments };
}
