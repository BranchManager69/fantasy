#!/usr/bin/env node

const { setTimeout: sleep } = require("node:timers/promises");
const path = require("node:path");
const fs = require("node:fs");

const API_BASE = process.env.FANTASY_REFRESH_API_BASE || "http://127.0.0.1:40435";
const SCENARIO = process.env.FANTASY_REFRESH_SCENARIO || "baseline";
const STATUS_ENDPOINT = `${API_BASE}/api/sim/rest-of-season/status?scenario=${encodeURIComponent(SCENARIO)}`;
const TRIGGER_ENDPOINT = `${API_BASE}/api/sim/rest-of-season/trigger?scenario=${encodeURIComponent(SCENARIO)}`;

const HISTORY_ROOT = process.env.FANTASY_REFRESH_HISTORY_ROOT
  ? path.resolve(process.cwd(), process.env.FANTASY_REFRESH_HISTORY_ROOT)
  : path.resolve(process.cwd(), "data", "history");
const DIFF_LOG_PATH = path.join(HISTORY_ROOT, "refresh-diff.log");

const DEFAULT_IDLE_INTERVAL_MINUTES = Number(process.env.FANTASY_REFRESH_IDLE_INTERVAL_MINUTES || 15);
const GAME_INTERVAL_MINUTES = Number(process.env.FANTASY_REFRESH_GAME_INTERVAL_MINUTES || 1);
const CHECK_FREQUENCY_SECONDS = Number(process.env.FANTASY_REFRESH_CHECK_SECONDS || 30);
const REQUEST_TIMEOUT_MS = Number(process.env.FANTASY_REFRESH_REQUEST_TIMEOUT_MS || 20000);
const OVERRIDES_PATH = process.env.FANTASY_REFRESH_OVERRIDE_PATH
  ? path.resolve(process.cwd(), process.env.FANTASY_REFRESH_OVERRIDE_PATH)
  : path.resolve(process.cwd(), "config", "refresh-overrides.json");

const MAX_SIM_HISTORY = Number(process.env.FANTASY_REFRESH_MAX_SIM_HISTORY || 48);
const MAX_SCORE_HISTORY = Number(process.env.FANTASY_REFRESH_MAX_SCORE_HISTORY || 96);
const MAX_DIFF_LOG_LINES = Number(process.env.FANTASY_REFRESH_MAX_DIFF_LOG_LINES || 2000);

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const LINEUP_SLOT_NAMES = new Map([
  [0, "QB"],
  [1, "TQB"],
  [2, "RB"],
  [3, "RB/WR"],
  [4, "WR"],
  [5, "WR/TE"],
  [6, "TE"],
  [7, "OP"],
  [8, "DT"],
  [9, "DE"],
  [10, "LB"],
  [11, "DL"],
  [12, "CB"],
  [13, "S"],
  [14, "DB"],
  [15, "DP"],
  [16, "D/ST"],
  [17, "K"],
  [18, "P"],
  [19, "HC"],
  [20, "BE"],
  [21, "IR"],
  [22, "FLEX"],
  [23, "FLEX"],
  [24, "Rookie"],
  [25, "Taxi"],
  [26, "ER"],
  [27, "Rookie Bench"],
]);

const NON_SCORING_LINEUP_SLOT_IDS = new Set([20, 21, 24, 25, 26, 27]);

const hm = (hours, minutes) => hours * 60 + minutes;

function parseTime(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes) || hours < 0 || hours > 24 || minutes < 0 || minutes > 59) {
    return null;
  }
  const total = hm(hours, minutes);
  return total > 1440 ? 1440 : total;
}

function loadOverrideWindows() {
  if (!fs.existsSync(OVERRIDES_PATH)) {
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
    const overrides = {};
    for (const [date, windows] of Object.entries(raw)) {
      if (!Array.isArray(windows)) continue;
      const parsed = windows
        .map((window) => {
          const start = parseTime(window.start || window.from);
          const end = parseTime(window.end || window.to);
          const intervalMinutes = Number(window.intervalMinutes || window.interval || GAME_INTERVAL_MINUTES);
          const label = window.label || `override-${date}`;
          if (start == null || end == null || intervalMinutes <= 0) {
            return null;
          }
          return { start, end, intervalMinutes, label };
        })
        .filter(Boolean);
      if (parsed.length) {
        overrides[date] = parsed;
      }
    }
    return overrides;
  } catch (error) {
    console.error(`[scheduler] failed to parse overrides at ${OVERRIDES_PATH}: ${error.message}`);
    return {};
  }
}

const BASE_WINDOWS = {
  0: [
    { start: hm(9, 30), end: hm(12, 30), intervalMinutes: GAME_INTERVAL_MINUTES, label: "sunday-london" },
    { start: hm(12, 0), end: hm(20, 30), intervalMinutes: GAME_INTERVAL_MINUTES, label: "sunday-afternoon" },
    { start: hm(20, 0), end: hm(24, 0), intervalMinutes: GAME_INTERVAL_MINUTES, label: "sunday-night" },
  ],
  1: [
    { start: hm(0, 0), end: hm(0, 30), intervalMinutes: GAME_INTERVAL_MINUTES, label: "post-snf" },
    { start: hm(19, 0), end: hm(24, 0), intervalMinutes: GAME_INTERVAL_MINUTES, label: "mnf" },
  ],
  2: [{ start: hm(0, 0), end: hm(0, 30), intervalMinutes: GAME_INTERVAL_MINUTES, label: "post-mnf" }],
  4: [{ start: hm(19, 0), end: hm(24, 0), intervalMinutes: GAME_INTERVAL_MINUTES, label: "tnf" }],
  5: [{ start: hm(0, 0), end: hm(0, 30), intervalMinutes: GAME_INTERVAL_MINUTES, label: "post-tnf" }],
};

const overridesByDate = loadOverrideWindows();

let lastFinishedAt = null;
let lastScoreSnapshot = null;

function getEasternContext(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const context = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    context[part.type] = part.value;
  }
  const weekdayIndex = WEEKDAY_MAP[context.weekday];
  const minutes = hm(Number(context.hour), Number(context.minute));
  const isoDate = `${context.year}-${context.month}-${context.day}`;
  return { weekdayIndex, minutes, isoDate };
}

function resolveInterval(now = new Date()) {
  const { weekdayIndex, minutes, isoDate } = getEasternContext(now);

  if (overridesByDate[isoDate]) {
    for (const window of overridesByDate[isoDate]) {
      if (minutes >= window.start && minutes < window.end) {
        return { intervalMinutes: window.intervalMinutes, label: window.label };
      }
    }
  }

  const windows = BASE_WINDOWS[weekdayIndex] || [];
  for (const window of windows) {
    if (minutes >= window.start && minutes < window.end) {
      return { intervalMinutes: window.intervalMinutes, label: window.label };
    }
  }

  return { intervalMinutes: DEFAULT_IDLE_INTERVAL_MINUTES, label: "off-hours" };
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "cache-control": "no-store",
        ...(options && options.headers ? options.headers : {}),
      },
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      let errorDetail = "";
      try {
        const body = await response.json();
        if (body && body.error) {
          errorDetail = ` – ${body.error}`;
        }
      } catch (err) {
        // ignore
      }
      throw new Error(`${response.status} ${response.statusText}${errorDetail}`);
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error("request timed out");
    }
    throw error;
  }
}

async function checkStatus() {
  try {
    return await fetchJson(STATUS_ENDPOINT, { method: "GET" });
  } catch (error) {
    console.error(`[scheduler] status check failed: ${error.message}`);
    return null;
  }
}

async function triggerRefresh(label) {
  try {
    await fetchJson(TRIGGER_ENDPOINT, { method: "POST" });
    console.log(`[scheduler] triggered refresh (${label}) at ${new Date().toISOString()}`);
    return true;
  } catch (error) {
    console.error(`[scheduler] trigger failed (${label}): ${error.message}`);
    return false;
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sanitizeTimestamp(isoString) {
  if (!isoString) return `unknown-${Date.now()}`;
  return isoString.replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

function splitCsv(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function toLineupSlot(slotId) {
  if (slotId == null || Number.isNaN(slotId)) {
    return "";
  }
  return LINEUP_SLOT_NAMES.get(Number(slotId)) || String(slotId);
}

function parseCountsForScore(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value == null) {
    return false;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const lowered = String(value).trim().toLowerCase();
  if (lowered === "true" || lowered === "1" || lowered === "yes" || lowered === "y") {
    return true;
  }
  if (lowered === "false" || lowered === "0" || lowered === "no" || lowered === "n") {
    return false;
  }
  return Boolean(value);
}

function buildSnapshotFromRows(rows, week) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { week, teamTotals: new Map(), playerScores: new Map() };
  }

  const teamTotals = new Map();
  const playerScores = new Map();

  for (const row of rows) {
    if (!row) continue;
    const teamId = Number.parseInt(row.teamId ?? row.team_id ?? 0, 10);
    if (Number.isNaN(teamId)) {
      continue;
    }

    const score = Number.parseFloat(row.score ?? row.score_total ?? 0) || 0;
    const countsForScore = parseCountsForScore(row.countsForScore ?? row.counts_for_score);
    const keyPlayerId = row.playerKey || row.playerId || row.espn_player_id || row.player_id || "unknown";
    const playerName = row.playerName || row.player_name || "";
    const lineupSlot = row.lineupSlot || row.lineup_slot || "";

    const existing = teamTotals.get(teamId) || { total: 0, counted: 0 };
    if (countsForScore) {
      existing.total += Number.isFinite(score) ? score : 0;
      existing.counted += 1;
    }
    teamTotals.set(teamId, existing);

    const key = `${teamId}::${keyPlayerId}::${lineupSlot}`;
    playerScores.set(key, {
      teamId,
      playerId: keyPlayerId,
      playerName,
      lineupSlot,
      score: Number.isFinite(score) ? score : 0,
      countsForScore,
    });
  }

  return { week, teamTotals, playerScores };
}

function loadScoreSnapshotFromCsv(csvPath, week) {
  const raw = fs.readFileSync(csvPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { week, teamTotals: new Map(), playerScores: new Map() };
  }

  const header = splitCsv(lines.shift());
  const teamIdx = header.indexOf("team_id");
  const scoreIdx = header.indexOf("score_total");
  const countsIdx = header.indexOf("counts_for_score");
  const playerIdIdx = header.indexOf("espn_player_id");
  const playerNameIdx = header.indexOf("player_name");
  const slotIdx = header.indexOf("lineup_slot");

  const rows = [];
  for (const line of lines) {
    const cols = splitCsv(line);
    rows.push({
      teamId: cols[teamIdx],
      score: cols[scoreIdx],
      countsForScore: (cols[countsIdx] || "").toLowerCase() === "true",
      playerId: cols[playerIdIdx] || "unknown",
      playerName: cols[playerNameIdx] || "",
      lineupSlot: cols[slotIdx] || "",
    });
  }

  return buildSnapshotFromRows(rows, week);
}

function loadRosterSlotMap(season, week) {
  const rosterPath = path.resolve(
    process.cwd(),
    "data",
    "raw",
    "espn",
    String(season),
    `view-mRoster-week-${week}.json`,
  );

  if (!fs.existsSync(rosterPath)) {
    return new Map();
  }

  try {
    const payload = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
    const map = new Map();
    for (const team of payload?.teams || []) {
      const teamId = team?.id;
      if (teamId == null) continue;
      const entries = team?.roster?.entries || [];
      for (const entry of entries) {
        const slotId = entry?.lineupSlotId;
        const poolEntry = entry?.playerPoolEntry || {};
        const player = poolEntry.player || {};
        const rawPlayerId = poolEntry.id ?? player.id;
        if (rawPlayerId == null) continue;
        const key = `${teamId}::${rawPlayerId}`;
        map.set(key, {
          slotId: slotId != null ? Number(slotId) : null,
          playerName: player.fullName || player.lastName || "Unknown",
          countsForScore:
            slotId == null ? true : !NON_SCORING_LINEUP_SLOT_IDS.has(Number(slotId)),
        });
      }
    }
    return map;
  } catch (error) {
    console.error(`[scheduler] failed to parse roster snapshot ${rosterPath}: ${error.message}`);
    return new Map();
  }
}

function loadScoreboardJsonSnapshot(jsonPath, week, season) {
  const raw = fs.readFileSync(jsonPath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error(`[scheduler] failed to parse scoreboard JSON ${jsonPath}: ${error.message}`);
    return { week, teamTotals: new Map(), playerScores: new Map() };
  }

  const schedule = Array.isArray(data?.schedule) ? data.schedule : [];
  const rows = [];
  let fallbackCounter = 0;
  const rosterMap = loadRosterSlotMap(season, week);
  const seenPlayers = new Set();

  for (const matchup of schedule) {
    if (!matchup || (matchup.matchupPeriodId != null && matchup.matchupPeriodId !== week)) {
      continue;
    }
    for (const side of ["home", "away"]) {
      const teamPayload = matchup[side];
      const teamId = teamPayload?.teamId;
      if (teamId == null) continue;

      const rosterEntries = teamPayload?.rosterForMatchupPeriod?.entries || [];
      for (const entry of rosterEntries) {
        const slotId = entry?.lineupSlotId;
        const poolEntry = entry?.playerPoolEntry || {};
        const player = poolEntry.player || {};
        const rawPlayerId = poolEntry.id ?? player.id;
        const numericPlayerId = rawPlayerId != null ? Number(rawPlayerId) : null;
        const playerId = numericPlayerId != null ? String(numericPlayerId) : `unknown-${teamId}-${fallbackCounter++}`;
        const rosterKey = numericPlayerId != null ? `${teamId}::${numericPlayerId}` : null;
        const rosterInfo = rosterKey ? rosterMap.get(rosterKey) : null;
        const playerName = rosterInfo?.playerName || player.fullName || player.lastName || "Unknown";

        let score = poolEntry.appliedStatTotal;
        if (score == null) {
          score = entry?.totalPointsLive ?? entry?.totalPoints ?? 0;
        }
        const numericScore = Number.parseFloat(score) || 0;
        const resolvedSlotId = rosterInfo?.slotId ?? (slotId != null ? Number(slotId) : null);
        const countsForScore = rosterInfo?.countsForScore ?? (resolvedSlotId == null
          ? true
          : !NON_SCORING_LINEUP_SLOT_IDS.has(resolvedSlotId));

        rows.push({
          teamId,
          playerId,
          playerName,
          lineupSlot: toLineupSlot(resolvedSlotId),
          score: numericScore,
          countsForScore,
        });
        if (rosterKey) {
          seenPlayers.add(rosterKey);
        }
      }
    }
  }

  if (rosterMap.size) {
    for (const [key, info] of rosterMap.entries()) {
      if (seenPlayers.has(key)) {
        continue;
      }
      const [teamIdRaw, playerIdRaw] = key.split("::");
      const teamId = Number.parseInt(teamIdRaw, 10);
      if (Number.isNaN(teamId)) continue;
      rows.push({
        teamId,
        playerId: playerIdRaw,
        playerName: info.playerName,
        lineupSlot: toLineupSlot(info.slotId),
        score: 0,
        countsForScore: parseCountsForScore(info.countsForScore),
      });
    }
  }

  return buildSnapshotFromRows(rows, week);
}

function loadScoreSnapshot(filePath, week, season) {
  if (filePath.endsWith(".json")) {
    return loadScoreboardJsonSnapshot(filePath, week, season);
  }
  return loadScoreSnapshotFromCsv(filePath, week);
}

function diffScoreSnapshots(previous, current, teamIndex) {
  if (!previous) {
    return { teamDiffs: [], playerDiffs: [] };
  }
  if (previous.week !== current.week) {
    return { teamDiffs: [], playerDiffs: [] };
  }

  const teamDiffs = [];
  const allTeamIds = new Set([
    ...Array.from(previous.teamTotals.keys()),
    ...Array.from(current.teamTotals.keys()),
  ]);
  for (const teamId of allTeamIds) {
    const prevStats = previous.teamTotals.get(teamId) || { total: 0, counted: 0 };
    const currStats = current.teamTotals.get(teamId) || { total: 0, counted: 0 };
    const delta = currStats.total - prevStats.total;
    if (Math.abs(delta) >= 0.05) {
      const meta = teamIndex.get(String(teamId)) || {};
      teamDiffs.push({
        teamId,
        abbrev: meta.abbrev || `Team ${teamId}`,
        name: meta.name || meta.team_name || `Team ${teamId}`,
        previousTotal: prevStats.total,
        currentTotal: currStats.total,
        delta,
      });
    }
  }
  teamDiffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const playerDiffs = [];
  const allPlayers = new Set([
    ...Array.from(previous.playerScores.keys()),
    ...Array.from(current.playerScores.keys()),
  ]);
  for (const key of allPlayers) {
    const prev = previous.playerScores.get(key) || null;
    const curr = current.playerScores.get(key) || null;
    const delta = (curr?.score || 0) - (prev?.score || 0);
    if (Math.abs(delta) < 0.05) {
      continue;
    }
    const teamId = curr?.teamId ?? prev?.teamId;
    const meta = teamIndex.get(String(teamId)) || {};
    playerDiffs.push({
      teamId,
      abbrev: meta.abbrev || `Team ${teamId}`,
      playerName: curr?.playerName || prev?.playerName || "Unknown",
      lineupSlot: curr?.lineupSlot || prev?.lineupSlot || "",
      previousScore: prev?.score || 0,
      currentScore: curr?.score || 0,
      delta,
      countsForScore: curr?.countsForScore ?? prev?.countsForScore ?? false,
    });
  }
  playerDiffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return { teamDiffs, playerDiffs };
}

function appendDiffLog(entry) {
  ensureDir(path.dirname(DIFF_LOG_PATH));
  fs.appendFileSync(DIFF_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  pruneDiffLog();
}

function pruneDiffLog() {
  if (MAX_DIFF_LOG_LINES <= 0 || !fs.existsSync(DIFF_LOG_PATH)) {
    return;
  }
  try {
    const lines = fs
      .readFileSync(DIFF_LOG_PATH, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length > MAX_DIFF_LOG_LINES) {
      const trimmed = lines.slice(-MAX_DIFF_LOG_LINES);
      fs.writeFileSync(`${DIFF_LOG_PATH}.tmp`, `${trimmed.join("\n")}\n`, "utf8");
      fs.renameSync(`${DIFF_LOG_PATH}.tmp`, DIFF_LOG_PATH);
    }
  } catch (error) {
    console.error(`[scheduler] failed to prune diff log: ${error.message}`);
  }
}

function pruneSnapshots(dirPath, maxCount, label) {
  if (maxCount <= 0 || !fs.existsSync(dirPath)) {
    return;
  }
  try {
    const entries = fs
      .readdirSync(dirPath)
      .map((name) => {
        const fullPath = path.join(dirPath, name);
        const stats = fs.statSync(fullPath);
        return { name, fullPath, stats };
      })
      .filter((entry) => entry.stats.isFile())
      .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);

    const excess = entries.slice(maxCount);
    for (const entry of excess) {
      try {
        fs.unlinkSync(entry.fullPath);
      } catch (error) {
        console.error(`[scheduler] failed to remove old ${label} snapshot ${entry.name}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`[scheduler] failed to prune ${label} history: ${error.message}`);
  }
}

function summarizeDiff(
  finishedAt,
  season,
  currentWeek,
  teamIndex,
  scoreboardSnapshot,
  previousSnapshot,
) {
  if (!scoreboardSnapshot) {
    return null;
  }

  const baselinePrevious = previousSnapshot ?? lastScoreSnapshot;
  const diff = diffScoreSnapshots(baselinePrevious, scoreboardSnapshot, teamIndex);
  lastScoreSnapshot = scoreboardSnapshot;

  if (!diff.teamDiffs.length && !diff.playerDiffs.length) {
    const summary = {
      finishedAt,
      season,
      week: currentWeek,
      message: `No stat deltas detected for week ${currentWeek}`,
      teamDiffs: [],
      playerDiffs: [],
      headlineTeams: [],
      headlinePlayers: [],
    };
    appendDiffLog(summary);
    return summary;
  }

  const topTeams = diff.teamDiffs.slice(0, 6).map((entry) => `${entry.abbrev}: ${entry.delta >= 0 ? "+" : ""}${entry.delta.toFixed(2)} (→ ${entry.currentTotal.toFixed(2)})`);
  const topPlayers = diff.playerDiffs
    .filter((entry) => entry.countsForScore)
    .slice(0, 6)
    .map((entry) => `${entry.playerName} (${entry.abbrev} ${entry.lineupSlot || ""}): ${entry.delta >= 0 ? "+" : ""}${entry.delta.toFixed(2)} (→ ${entry.currentScore.toFixed(2)})`);

  const summary = {
    finishedAt,
    season,
    week: currentWeek,
    teamDiffs: diff.teamDiffs,
    playerDiffs: diff.playerDiffs,
    headlineTeams: topTeams,
    headlinePlayers: topPlayers,
  };

  appendDiffLog(summary);

  return summary;
}

function archiveArtifacts(finishedAt) {
  const simulationRoot = path.resolve(process.cwd(), "data", "out", "simulations");
  let baselinePath = null;
  let resolvedSeason = null;

  try {
    const entries = fs
      .readdirSync(simulationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^\d+$/.test(name))
      .sort((a, b) => Number(a) - Number(b));
    const latestSeason = entries.at(-1);
    if (latestSeason) {
      const candidate = path.join(simulationRoot, latestSeason, "rest_of_season.json");
      if (fs.existsSync(candidate)) {
        baselinePath = candidate;
        resolvedSeason = Number.parseInt(latestSeason, 10);
      }
    }
  } catch (error) {
    console.error(`[scheduler] unable to inspect simulation directory: ${error.message}`);
  }

  if (!baselinePath) {
    console.error("[scheduler] baseline simulation missing; skipping diff archival");
    return null;
  }

  const dataset = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const season = dataset.season || resolvedSeason || 0;
  const teams = Array.isArray(dataset.teams) ? dataset.teams : [];
  const teamIndex = new Map();
  for (const team of teams) {
    const key = String(team.team_id ?? team.teamId ?? "");
    if (key) {
      teamIndex.set(key, team);
    }
  }

  const completedWeeks = Array.isArray(dataset.sources?.completed_weeks)
    ? dataset.sources.completed_weeks
    : [];
  const currentWeek = completedWeeks.length ? Math.max(...completedWeeks) : null;

  const stamp = sanitizeTimestamp(finishedAt);
  const simulationHistoryDir = path.join(HISTORY_ROOT, "simulations", String(season));
  ensureDir(simulationHistoryDir);
  const simulationHistoryPath = path.join(simulationHistoryDir, `rest_of_season__${stamp}.json`);
  try {
    fs.copyFileSync(baselinePath, simulationHistoryPath);
  } catch (error) {
    console.error(`[scheduler] failed to archive simulation snapshot: ${error.message}`);
  }
  pruneSnapshots(simulationHistoryDir, MAX_SIM_HISTORY, "simulation");

  if (!currentWeek || !season) {
    return null;
  }

  const scoreboardHistoryDir = path.join(
    HISTORY_ROOT,
    "weekly_scores",
    `${season}_week_${currentWeek}`,
  );
  ensureDir(scoreboardHistoryDir);
  const scoreboardJsonPath = path.resolve(
    process.cwd(),
    "data",
    "raw",
    "espn",
    String(season),
    `view-mScoreboard-week-${currentWeek}.json`,
  );
  const scoreboardCsvPath = path.resolve(
    process.cwd(),
    "data",
    "out",
    "espn",
    String(season),
    `weekly_scores_${season}_week_${currentWeek}.csv`,
  );

  let snapshotSourcePath = null;

  if (fs.existsSync(scoreboardJsonPath)) {
    snapshotSourcePath = scoreboardJsonPath;
    const historyPath = path.join(
      scoreboardHistoryDir,
      `scoreboard_week_${currentWeek}__${stamp}.json`,
    );
    try {
      fs.copyFileSync(scoreboardJsonPath, historyPath);
    } catch (error) {
      console.error(`[scheduler] failed to archive scoreboard JSON: ${error.message}`);
    }
  } else if (fs.existsSync(scoreboardCsvPath)) {
    snapshotSourcePath = scoreboardCsvPath;
    const historyPath = path.join(
      scoreboardHistoryDir,
      `weekly_scores_${season}_week_${currentWeek}__${stamp}.csv`,
    );
    try {
      fs.copyFileSync(scoreboardCsvPath, historyPath);
    } catch (error) {
      console.error(`[scheduler] failed to archive scoreboard snapshot: ${error.message}`);
    }
  } else {
    console.warn(`[scheduler] scoreboard artifact missing for week ${currentWeek}`);
    return null;
  }

  pruneSnapshots(scoreboardHistoryDir, MAX_SCORE_HISTORY, "scoreboard");

  let previousSnapshot = lastScoreSnapshot;
  if (!previousSnapshot) {
    try {
      const historyFiles = fs
        .readdirSync(scoreboardHistoryDir)
        .map((name) => {
          const fullPath = path.join(scoreboardHistoryDir, name);
          const stats = fs.statSync(fullPath);
          return { name, fullPath, stats };
        })
        .filter((entry) => entry.stats.isFile())
        .sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs);
      if (historyFiles.length >= 2) {
        const prior = historyFiles[historyFiles.length - 2];
        previousSnapshot = loadScoreSnapshot(prior.fullPath, currentWeek, season);
      }
    } catch (error) {
      console.error(`[scheduler] failed to inspect scoreboard history: ${error.message}`);
    }
  }

  const snapshot = loadScoreSnapshot(snapshotSourcePath, currentWeek, season);
  const summary = summarizeDiff(
    finishedAt,
    season,
    currentWeek,
    teamIndex,
    snapshot,
    previousSnapshot,
  );
  return summary;
}

async function run() {
  let lastRun = 0;
  let lastWindowLabel = null;

  console.log(`[scheduler] starting – API base ${API_BASE}, scenario ${SCENARIO}`);
  if (fs.existsSync(OVERRIDES_PATH)) {
    console.log(`[scheduler] loaded overrides from ${OVERRIDES_PATH}`);
  }

  while (true) {
    const status = await checkStatus();
    if (status?.job?.status === "success" && status.job.finishedAt && status.job.finishedAt !== lastFinishedAt) {
      try {
        const summary = archiveArtifacts(status.job.finishedAt);
        lastFinishedAt = status.job.finishedAt;
        if (summary) {
          if (summary.teamDiffs?.length || summary.playerDiffs?.length) {
            console.log(
              `[scheduler] refresh @ ${summary.finishedAt} week ${summary.week}: ${summary.headlineTeams.join(", ") || "team totals unchanged"}`,
            );
            if (summary.headlinePlayers?.length) {
              console.log(`           top players: ${summary.headlinePlayers.join(", ")}`);
            }
          } else {
            console.log(`[scheduler] refresh @ ${summary.finishedAt} week ${summary.week}: ${summary.message}`);
          }
        }
      } catch (error) {
        console.error(`[scheduler] failed to process refresh snapshot: ${error.message}`);
        lastFinishedAt = status.job.finishedAt;
      }
    }

    const { intervalMinutes, label } = resolveInterval();
    const intervalMs = intervalMinutes * 60 * 1000;

    if (label !== lastWindowLabel) {
      console.log(`[scheduler] active window: ${label} (${intervalMinutes}m cadence)`);
      lastWindowLabel = label;
    }

    const now = Date.now();
    if (now - lastRun >= intervalMs) {
      if (status?.job?.status === "running") {
        console.log(`[scheduler] refresh already running (started ${status.job.startedAt ?? "unknown"})`);
      } else {
        const triggered = await triggerRefresh(label);
        if (triggered) {
          lastRun = Date.now();
        }
      }
    }

    await sleep(CHECK_FREQUENCY_SECONDS * 1000);
  }
}

run().catch((error) => {
  console.error(`[scheduler] fatal error: ${error.stack || error.message}`);
  process.exitCode = 1;
});
