import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LeagueWeek } from "../apps/web/src/lib/league-week";
import { loadLeagueTimeline } from "../apps/web/src/server/analyst-timeline";

async function main() {
  const args = process.argv.slice(2);
  const readNumber = (flag: string) => Number(args[args.indexOf(flag) + 1]);
  const season = readNumber("--season"), week = readNumber("--week");
  if (!args.includes("--season") || !args.includes("--week") || !Number.isInteger(season)
    || season < 2000 || season > 2100 || !Number.isInteger(week) || week < 1 || week > 18) {
    throw new Error("Usage: tsx scripts/build-week-timeline.ts --season 2026 --week 1");
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const data = path.join(root, "data"), directory = path.join(data, "out", "league", String(season));
  const reportPath = path.join(directory, `week_${week}.json`);
  const stat = await fs.stat(reportPath);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error("Weekly report exceeds the size limit");
  const report: LeagueWeek = JSON.parse(await fs.readFile(reportPath, "utf8"));
  if (report.season !== season || report.week !== week) throw new Error("Weekly report selection mismatch");
  const timeline = await loadLeagueTimeline(data, report);
  const output = path.join(directory, `week_${week}_timeline.json`);
  await fs.writeFile(`${output}.tmp`, JSON.stringify(timeline, null, 2) + "\n");
  await fs.rename(`${output}.tmp`, output);
  console.log(JSON.stringify({ output, coverage: timeline.coverage, selected_feature: timeline.selectedFeature,
    matchups_with_players_in_latest_window: timeline.matchups_with_players_in_latest_window }, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
