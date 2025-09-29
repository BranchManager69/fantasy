import fs from "node:fs/promises";
import path from "node:path";

import { historyRoot } from "@/lib/paths";

const DIFF_LOG_PATH = path.join(historyRoot, "refresh-diff.log");

export type RefreshDiffTeamDelta = {
  teamId?: number | null;
  abbrev?: string | null;
  name?: string | null;
  previousTotal?: number | null;
  currentTotal?: number | null;
  delta: number;
};

export type RefreshDiffPlayerDelta = {
  teamId?: number | null;
  abbrev?: string | null;
  playerName: string;
  lineupSlot?: string | null;
  previousScore?: number | null;
  currentScore?: number | null;
  delta: number;
  countsForScore?: boolean;
};

export type RefreshDiffEntry = {
  finishedAt: string;
  season?: number | null;
  week?: number | null;
  message?: string | null;
  teamDiffs: RefreshDiffTeamDelta[];
  playerDiffs: RefreshDiffPlayerDelta[];
  headlineTeams?: string[];
  headlinePlayers?: string[];
  hasChanges: boolean;
};

function parseLine(line: string): RefreshDiffEntry | null {
  try {
    const parsed = JSON.parse(line) as Partial<RefreshDiffEntry>;
    if (!parsed || typeof parsed.finishedAt !== "string") {
      return null;
    }
    const teamDiffs = Array.isArray(parsed.teamDiffs) ? parsed.teamDiffs : [];
    const playerDiffs = Array.isArray(parsed.playerDiffs) ? parsed.playerDiffs : [];
    const hasChanges = teamDiffs.length > 0 || playerDiffs.length > 0;
    return {
      finishedAt: parsed.finishedAt,
      season: parsed.season ?? null,
      week: parsed.week ?? null,
      message: parsed.message ?? null,
      teamDiffs,
      playerDiffs,
      headlineTeams: Array.isArray(parsed.headlineTeams) ? parsed.headlineTeams : [],
      headlinePlayers: Array.isArray(parsed.headlinePlayers) ? parsed.headlinePlayers : [],
      hasChanges,
    };
  } catch (error) {
    return null;
  }
}

export async function readDiffEntries(limit: number, { includeEmpties = true } = {}): Promise<RefreshDiffEntry[]> {
  if (limit <= 0) {
    return [];
  }

  try {
    const raw = await fs.readFile(DIFF_LOG_PATH, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse();

    const entries: RefreshDiffEntry[] = [];
    for (const line of lines) {
      const entry = parseLine(line);
      if (!entry) continue;
      if (!includeEmpties && !entry.hasChanges) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
    return entries;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
