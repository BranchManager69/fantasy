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

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

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

function loadScoreSnapshot(csvPath, week) {
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

  const teamTotals = new Map();
  const playerScores = new Map();

  for (const line of lines) {
    const cols = splitCsv(line);
    const teamIdRaw = cols[teamIdx];
    const countsForScore = (cols[countsIdx] || "").toLowerCase() === "true";
    const score = Number.parseFloat(cols[scoreIdx] || "0");
    const playerId = cols[playerIdIdx] || "unknown";
    const playerName = cols[playerNameIdx] || "";
    const slot = cols[slotIdx] || "";
    const teamId = Number.parseInt(teamIdRaw || "0", 10);

    if (Number.isNaN(teamId)) {
      continue;
    }

    const existing = teamTotals.get(teamId) || { total: 0, counted: 0 };
    if (countsForScore) {
      existing.total += Number.isFinite(score) ? score : 0;
      existing.counted += 1;
    }
    teamTotals.set(teamId, existing);

    const key = `${teamId}::${playerId}::${slot}`;
    playerScores.set(key, {
      teamId,
      playerId,
      playerName,
      lineupSlot: slot,
      score: Number.isFinite(score) ? score : 0,
      countsForScore,
    });
  }

  return { week, teamTotals, playerScores };
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
}

function summarizeDiff(finishedAt, season, currentWeek, teamIndex, scoreboardSnapshot) {
  if (!scoreboardSnapshot) {
    return null;
  }

  const diff = diffScoreSnapshots(lastScoreSnapshot, scoreboardSnapshot, teamIndex);
  lastScoreSnapshot = scoreboardSnapshot;

  if (!diff.teamDiffs.length && !diff.playerDiffs.length) {
    return {
      finishedAt,
      week: currentWeek,
      message: `No stat deltas detected for week ${currentWeek}`,
      teamDiffs: [],
      playerDiffs: [],
    };
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

  if (!currentWeek || !season) {
    return null;
  }

  const scoreboardPath = path.resolve(
    process.cwd(),
    "data",
    "out",
    "espn",
    String(season),
    `weekly_scores_${season}_week_${currentWeek}.csv`,
  );

  if (!fs.existsSync(scoreboardPath)) {
    console.warn(`[scheduler] scoreboard artifact missing for week ${currentWeek}`);
    return null;
  }

  const scoreboardHistoryDir = path.join(
    HISTORY_ROOT,
    "weekly_scores",
    `${season}_week_${currentWeek}`,
  );
  ensureDir(scoreboardHistoryDir);
  const scoreboardHistoryPath = path.join(
    scoreboardHistoryDir,
    `weekly_scores_${season}_week_${currentWeek}__${stamp}.csv`,
  );
  try {
    fs.copyFileSync(scoreboardPath, scoreboardHistoryPath);
  } catch (error) {
    console.error(`[scheduler] failed to archive scoreboard snapshot: ${error.message}`);
  }

  const snapshot = loadScoreSnapshot(scoreboardPath, currentWeek);
  const summary = summarizeDiff(finishedAt, season, currentWeek, teamIndex, snapshot);
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
