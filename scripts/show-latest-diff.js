#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const HISTORY_ROOT = process.env.FANTASY_REFRESH_HISTORY_ROOT
  ? path.resolve(process.cwd(), process.env.FANTASY_REFRESH_HISTORY_ROOT)
  : path.resolve(process.cwd(), "data", "history");
const LOG_PATH = path.join(HISTORY_ROOT, "refresh-diff.log");

function loadLatestEntry() {
  if (!fs.existsSync(LOG_PATH)) {
    return null;
  }
  const raw = fs.readFileSync(LOG_PATH, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return null;
  }
  try {
    return JSON.parse(lines.at(-1));
  } catch (error) {
    throw new Error(`Unable to parse last diff entry: ${error.message}`);
  }
}

function renderSummary(entry) {
  const { finishedAt, season, week, headlineTeams = [], headlinePlayers = [], message } = entry;
  const lines = [];
  lines.push(`Finished at: ${finishedAt}`);
  if (season) {
    lines.push(`Season: ${season}`);
  }
  if (week) {
    lines.push(`Week: ${week}`);
  }

  if (headlineTeams.length) {
    lines.push("Team swings:");
    for (const line of headlineTeams) {
      lines.push(`  - ${line}`);
    }
  }

  if (headlinePlayers.length) {
    lines.push("Player swings:");
    for (const line of headlinePlayers) {
      lines.push(`  - ${line}`);
    }
  }

  if (!headlineTeams.length && !headlinePlayers.length && message) {
    lines.push(message);
  }

  return lines.join("\n");
}

try {
  const latest = loadLatestEntry();
  if (!latest) {
    console.log("No refresh diff entries recorded yet.");
    process.exit(0);
  }
  console.log(renderSummary(latest));
} catch (error) {
  console.error(`Failed to load diff summary: ${error.message}`);
  process.exitCode = 1;
}
