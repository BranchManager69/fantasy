import { promises as fs } from "node:fs";
import fssync from "node:fs";
import path from "node:path";

import { getDataRoot, seasonDir } from "@/lib/paths";

type SnapshotRow = {
  teamId: number;
  score: number;
  countsForScore: boolean;
};

type Snapshot = {
  timestamp: number; // ms epoch
  byTeam: Map<number, number>; // teamId -> total scored
};

const NON_SCORING_LINEUP_SLOT_IDS = new Set([20, 21, 24, 25, 26, 27]);

function toLineupSlot(slotId: unknown): string {
  if (slotId == null) return "";
  const n = Number(slotId);
  if (!Number.isFinite(n)) return String(slotId);
  const names: Record<number, string> = {
    0: "QB",
    1: "TQB",
    2: "RB",
    3: "RB/WR",
    4: "WR",
    5: "WR/TE",
    6: "TE",
    7: "OP",
    8: "DT",
    9: "DE",
    10: "LB",
    11: "DL",
    12: "CB",
    13: "S",
    14: "DB",
    15: "DP",
    16: "D/ST",
    17: "K",
    18: "P",
    19: "HC",
    20: "BE",
    21: "IR",
    22: "FLEX",
    23: "FLEX",
    24: "Rookie",
    25: "Taxi",
    26: "ER",
    27: "Rookie Bench",
  };
  return names[n] ?? String(n);
}

async function readFileMaybe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function parseCsvSnapshot(csv: string): SnapshotRow[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const ixTeam = idx("team_id");
  const ixScore = idx("score_total");
  const ixCounts = idx("counts_for_score");
  const rows: SnapshotRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",");
    const teamId = Number(cols[ixTeam]);
    if (!Number.isFinite(teamId)) continue;
    const score = Number(cols[ixScore] ?? 0) || 0;
    const counts = String(cols[ixCounts] ?? "").toLowerCase() === "true";
    rows.push({ teamId, score, countsForScore: counts });
  }
  return rows;
}

function parseJsonScoreboardSnapshot(jsonText: string): SnapshotRow[] {
  let data: any;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const schedule: any[] = Array.isArray(data?.schedule) ? data.schedule : [];
  const rows: SnapshotRow[] = [];
  for (const matchup of schedule) {
    for (const side of ["home", "away"]) {
      const teamPayload = matchup?.[side];
      const teamId = teamPayload?.teamId;
      if (teamId == null) continue;
      const entries = teamPayload?.rosterForMatchupPeriod?.entries || [];
      for (const entry of entries) {
        const slotId = entry?.lineupSlotId;
        const pool = entry?.playerPoolEntry || {};
        const player = pool.player || {};
        let score = pool.appliedStatTotal;
        if (score == null) score = entry?.totalPointsLive ?? entry?.totalPoints ?? 0;
        const counts = slotId == null ? true : !NON_SCORING_LINEUP_SLOT_IDS.has(Number(slotId));
        rows.push({ teamId: Number(teamId), score: Number(score) || 0, countsForScore: counts });
      }
    }
  }
  return rows;
}

function summarizeSnapshot(rows: SnapshotRow[], mtimeMs: number): Snapshot {
  const byTeam = new Map<number, number>();
  for (const r of rows) {
    if (!r.countsForScore) continue;
    byTeam.set(r.teamId, (byTeam.get(r.teamId) || 0) + r.score);
  }
  return { timestamp: mtimeMs, byTeam };
}

export async function loadScheduleRow(
  season: number,
  matchupId: string,
): Promise<{ week: number; homeTeamId: number; awayTeamId: number } | null> {
  const schedPath = path.join(seasonDir(season), "schedule.csv");
  const csv = await readFileMaybe(schedPath);
  if (!csv) return null;
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(",");
  const idx = (name: string) => header.indexOf(name);
  const ixId = idx("matchup_id");
  const ixWeek = idx("week");
  const ixHome = idx("home_team_id");
  const ixAway = idx("away_team_id");
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",");
    if ((cols[ixId] ?? "").trim() !== String(matchupId)) continue;
    const week = Number(cols[ixWeek]);
    const home = Number(cols[ixHome]);
    const away = Number(cols[ixAway]);
    if (!Number.isFinite(week) || !Number.isFinite(home) || !Number.isFinite(away)) continue;
    return { week, homeTeamId: home, awayTeamId: away };
  }
  return null;
}

export async function loadSnapshotsForWeek(
  season: number,
  week: number,
): Promise<Snapshot[]> {
  const dir = path.join(getDataRoot(), "history", "weekly_scores", `${season}_week_${week}`);
  let entries: { name: string; full: string; mtimeMs: number }[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => {
        const full = path.join(dir, d.name);
        const s = fssync.statSync(full);
        return { name: d.name, full, mtimeMs: s.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    return [];
  }
  const snapshots: Snapshot[] = [];
  for (const e of entries) {
    if (e.name.endsWith(".json")) {
      const text = await readFileMaybe(e.full);
      if (!text) continue;
      const rows = parseJsonScoreboardSnapshot(text);
      snapshots.push(summarizeSnapshot(rows, e.mtimeMs));
    } else if (e.name.endsWith(".csv")) {
      const text = await readFileMaybe(e.full);
      if (!text) continue;
      const rows = parseCsvSnapshot(text);
      snapshots.push(summarizeSnapshot(rows, e.mtimeMs));
    }
  }
  return snapshots;
}

export function gaussianWinProb(homePoints: number, awayPoints: number, sigma = 18): { home: number; away: number } {
  const margin = homePoints - awayPoints;
  if (sigma <= 0) {
    if (margin > 0) return { home: 1, away: 0 };
    if (margin < 0) return { home: 0, away: 1 };
    return { home: 0.5, away: 0.5 };
  }
  // Approximate erf(x)
  const z = margin / (Math.SQRT2 * sigma);
  const t = 1 / (1 + 0.5 * Math.abs(z));
  const tau = t * Math.exp(
    -z * z -
      1.26551223 +
      1.00002368 * t +
      0.37409196 * t * t +
      0.09678418 * t ** 3 -
      0.18628806 * t ** 4 +
      0.27886807 * t ** 5 -
      1.13520398 * t ** 6 +
      1.48851587 * t ** 7 -
      0.82215223 * t ** 8 +
      0.17087277 * t ** 9,
  );
  const erf = z >= 0 ? 1 - tau : tau - 1;
  const home = Math.max(0, Math.min(1, 0.5 * (1 + erf)));
  return { home, away: 1 - home };
}

export type WinProbPoint = {
  t: number; // ms epoch
  home_pts: number;
  away_pts: number;
  home_win: number;
  away_win: number;
};

export async function buildWinProbSeries(
  season: number,
  matchupId: string,
  fromTs?: number,
  toTs?: number,
  sigma = 18,
): Promise<{ series: WinProbPoint[]; meta: { week: number; homeTeamId: number; awayTeamId: number } } | null> {
  const sched = await loadScheduleRow(season, matchupId);
  if (!sched) return null;
  const { week, homeTeamId, awayTeamId } = sched;
  const snapshots = await loadSnapshotsForWeek(season, week);
  if (!snapshots.length) return { series: [], meta: { week, homeTeamId, awayTeamId } };
  const series: WinProbPoint[] = [];
  for (const snap of snapshots) {
    if (fromTs && snap.timestamp < fromTs) continue;
    if (toTs && snap.timestamp > toTs) continue;
    const home = snap.byTeam.get(homeTeamId) || 0;
    const away = snap.byTeam.get(awayTeamId) || 0;
    const prob = gaussianWinProb(home, away, sigma);
    series.push({ t: snap.timestamp, home_pts: home, away_pts: away, home_win: prob.home, away_win: prob.away });
  }
  return { series, meta: { week, homeTeamId, awayTeamId } };
}


