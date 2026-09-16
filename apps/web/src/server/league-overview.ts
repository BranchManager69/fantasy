import { promises as fs } from "node:fs";
import path from "node:path";
import type { LeagueWeek, WeekTeam } from "@/lib/league-week";
import type { WeekLeagueOverview } from "@/lib/league-overview";
import { getDataRoot } from "@/lib/paths";

type JsonObject = Record<string, unknown>;
type RecordTotals = { wins: number; losses: number; ties: number; pointsFor: number; pointsAgainst: number };
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown): value is number => finite(value) && Number.isInteger(value);
const cents = (value: number) => Math.round(value * 100);
const clip = (value: unknown, maximum = 160) => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const MAX_BYTES = 20 * 1024 * 1024;

async function readSnapshot(filename: string): Promise<JsonObject | null> {
  let handle;
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return null;
    handle = await fs.open(filename, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== opened.size) return null;
    const parsed: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    return object(Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed);
  } catch {
    return null;
  } finally { await handle?.close(); }
}

function sourceUrl(report: LeagueWeek): string | null {
  try {
    const url = new URL(report.sourceUrl);
    const league = url.searchParams.get("leagueId");
    if (url.protocol !== "https:" || url.hostname !== "fantasy.espn.com" || !league || !/^\d+$/.test(league)) return null;
    return `https://fantasy.espn.com/football/league/standings?leagueId=${league}&seasonId=${report.season}`;
  } catch { return null; }
}

function finalPair(team: WeekTeam, byId: Map<number, WeekTeam>, report: LeagueWeek): boolean {
  const opponent = byId.get(team.opponentId);
  const matchup = Array.isArray(report.matchups) && report.matchups.find((entry) => entry.id === team.matchupId
    && [entry.homeId, entry.awayId].includes(team.id) && [entry.homeId, entry.awayId].includes(team.opponentId));
  return Boolean(opponent && opponent.id !== team.id && opponent.opponentId === team.id && opponent.matchupId === team.matchupId
    && team.final && opponent.final && matchup && matchup.final
    && integer(report.currentWeek) && report.currentWeek >= report.week
    && finite(team.opponentScore) && finite(opponent.opponentScore)
    && cents(team.score) === cents(opponent.opponentScore) && cents(opponent.score) === cents(team.opponentScore));
}

function blankTotals(ids: number[]): Map<number, RecordTotals> {
  return new Map(ids.map((id) => [id, { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 }]));
}

function addResult(totals: RecordTotals, score: number, against: number, result: "win" | "loss" | "tie") {
  totals[result === "win" ? "wins" : result === "loss" ? "losses" : "ties"]++;
  totals.pointsFor = (cents(totals.pointsFor) + cents(score)) / 100;
  totals.pointsAgainst = (cents(totals.pointsAgainst) + cents(against)) / 100;
}

/** Reconstruct only complete, single-week head-to-head periods. Future or unresolved results never count. */
function historicalTotals(snapshot: JsonObject, report: LeagueWeek, through: number): Map<number, RecordTotals> | null {
  const settings = object(object(snapshot.settings).scheduleSettings);
  if (settings.matchupPeriodLength !== 1 || !integer(settings.matchupPeriodCount) || through > settings.matchupPeriodCount
    || !Array.isArray(snapshot.schedule) || snapshot.schedule.length > 600) return null;
  const ids = report.teams.map((team) => team.id);
  const totals = blankTotals(ids);
  const reportById = new Map(report.teams.map((team) => [team.id, team]));
  for (let period = 1; period <= through; period++) {
    const periods = object(settings.matchupPeriods)[String(period)];
    if (!Array.isArray(periods) || periods.length !== 1 || periods[0] !== period) return null;
    const matches = snapshot.schedule.map(object).filter((match) => match.matchupPeriodId === period);
    if (matches.length !== ids.length / 2) return null;
    const seen = new Set<number>();
    for (const match of matches) {
      const home = object(match.home), away = object(match.away);
      if (!integer(home.teamId) || !integer(away.teamId) || home.teamId === away.teamId
        || !totals.has(home.teamId) || !totals.has(away.teamId) || seen.has(home.teamId) || seen.has(away.teamId)
        || !finite(home.totalPoints) || !finite(away.totalPoints) || !["HOME", "AWAY", "TIE"].includes(String(match.winner))) return null;
      if ((match.winner === "HOME" && cents(home.totalPoints) < cents(away.totalPoints))
        || (match.winner === "AWAY" && cents(away.totalPoints) < cents(home.totalPoints))
        || (match.winner === "TIE" && cents(home.totalPoints) !== cents(away.totalPoints))) return null;
      if (period === report.week) {
        for (const [side, other] of [[home, away], [away, home]]) {
          const team = reportById.get(side.teamId as number)!;
          if (team.matchupId !== match.id || team.opponentId !== other.teamId || cents(team.score) !== cents(side.totalPoints as number)) return null;
        }
      }
      seen.add(home.teamId); seen.add(away.teamId);
      addResult(totals.get(home.teamId)!, home.totalPoints, away.totalPoints, match.winner === "HOME" ? "win" : match.winner === "AWAY" ? "loss" : "tie");
      addResult(totals.get(away.teamId)!, away.totalPoints, home.totalPoints, match.winner === "AWAY" ? "win" : match.winner === "HOME" ? "loss" : "tie");
    }
  }
  return totals;
}

function firstWeekTotals(report: LeagueWeek, final: boolean): Map<number, RecordTotals> | null {
  if (report.week !== 1 || !final) return null;
  const totals = blankTotals(report.teams.map((team) => team.id));
  const byId = new Map(report.teams.map((team) => [team.id, team]));
  for (const team of report.teams) {
    const result = team.result, opponent = byId.get(team.opponentId)!;
    if (!["win", "loss", "tie"].includes(result)
      || opponent.result !== (result === "win" ? "loss" : result === "loss" ? "win" : "tie")
      || (result === "win" && team.score < opponent.score) || (result === "loss" && team.score > opponent.score)
      || (result === "tie" && cents(team.score) !== cents(opponent.score))) return null;
    addResult(totals.get(team.id)!, team.score, opponent.score, result as "win" | "loss" | "tie");
  }
  return totals;
}

export async function buildLeagueOverview(report: LeagueWeek): Promise<WeekLeagueOverview> {
  const validSelection = integer(report?.season) && report.season >= 2000 && report.season <= 2100
    && integer(report.week) && report.week >= 1 && report.week <= 18;
  const teams = validSelection && Array.isArray(report.teams) && report.teams.length <= 32 ? report.teams : [];
  const validTeams = teams.length > 1 && teams.length % 2 === 0
    && teams.every((team) => integer(team.id) && team.id > 0 && finite(team.score))
    && new Set(teams.map((team) => team.id)).size === teams.length;
  const byId = new Map((validTeams ? teams : []).map((team) => [team.id, team]));
  const completeIds = new Set([...byId.values()].filter((team) => finalPair(team, byId, report)).map((team) => team.id));
  const final = Boolean(validTeams && report.complete && completeIds.size === teams.length);
  const scores = [...byId.values()].map((team) => team.score).sort((a, b) => a - b);
  const scale = { min: Math.min(0, Math.floor((scores[0] ?? 0) / 10) * 10), max: Math.max(10, Math.ceil((scores.at(-1) ?? 0) / 10) * 10) };
  const result: WeekLeagueOverview = { season: validSelection ? report.season : 0, week: validSelection ? report.week : 0,
    currentWeek: integer(report?.currentWeek) && report.currentWeek >= 1 && report.currentWeek <= 18 ? report.currentWeek : null,
    throughWeek: null, final, teams: {}, aggregate: { teamCount: byId.size, totalMatchups: byId.size / 2,
      completedMatchups: completeIds.size / 2, high: null, low: null, median: null, scale },
    standingsBasis: null, recordsBasis: null, sourceUrl: validSelection ? sourceUrl(report) : null,
    note: "Season records and standings are unavailable for this historical week." };
  if (!validTeams) return result;
  if (final) {
    const high = scores.at(-1)!, low = scores[0];
    const idsAt = (score: number) => teams.filter((team) => cents(team.score) === cents(score)).map((team) => team.id).sort((a, b) => a - b);
    result.aggregate.high = { score: high, teamIds: idsAt(high) };
    result.aggregate.low = { score: low, teamIds: idsAt(low) };
    result.aggregate.median = (cents(scores[scores.length / 2 - 1]) + cents(scores[scores.length / 2])) / 200;
  }
  const root = path.join(getDataRoot(), "raw", "espn", String(report.season));
  const through = final ? report.week : Math.max(0, Math.min(report.week - 1, (result.currentWeek ?? 1) - 1));
  let snapshot: JsonObject | null = null;
  const leagueId = result.sourceUrl ? new URL(result.sourceUrl).searchParams.get("leagueId") : null;
  for (const name of [`view-mMatchupScore-week-${report.week}.json`, "league-snapshot.json"]) {
    const candidate = await readSnapshot(path.join(root, name));
    if (candidate?.seasonId === report.season && leagueId && String(candidate.id) === leagueId
      && (name === "league-snapshot.json" || candidate.scoringPeriodId === report.week)) {
      snapshot = candidate; break;
    }
  }
  const totals = through > 0 && snapshot ? historicalTotals(snapshot, report, through) ?? firstWeekTotals(report, final) : firstWeekTotals(report, final);
  const snapshotTeams = Array.isArray(snapshot?.teams) ? snapshot.teams.map(object) : [];
  const snapshotById = new Map(snapshotTeams.filter((team) => integer(team.id)).map((team) => [team.id as number, team]));
  const officialRecordsMatch = Boolean(totals && snapshotTeams.length === byId.size && snapshotById.size === byId.size
    && [...totals].every(([id, total]) => {
      const overall = object(object(snapshotById.get(id)?.record).overall);
      return ["wins", "losses", "ties"].every((key) => overall[key] === total[key as keyof RecordTotals])
        && finite(overall.pointsFor) && finite(overall.pointsAgainst)
        && cents(overall.pointsFor) === cents(total.pointsFor) && cents(overall.pointsAgainst) === cents(total.pointsAgainst);
    }));
  const seeds = [...byId.keys()].map((id) => snapshotById.get(id)?.playoffSeed);
  const seedsVerified = officialRecordsMatch && seeds.every((seed) => integer(seed) && seed >= 1 && seed <= byId.size)
    && new Set(seeds).size === seeds.length;
  const scheduleSettings = object(object(snapshot?.settings).scheduleSettings);
  const divisions = Array.isArray(scheduleSettings.divisions) ? scheduleSettings.divisions.map(object)
    .filter((division) => integer(division.id) && clip(division.name)) : [];
  const oneDivision = divisions.length === 1 && [...byId.keys()].every((id) => snapshotById.get(id)?.divisionId === divisions[0].id);
  for (const team of teams) {
    const total = totals?.get(team.id);
    const rank = seedsVerified ? snapshotById.get(team.id)!.playoffSeed as number : null;
    const division = divisions.find((entry) => entry.id === snapshotById.get(team.id)?.divisionId);
    result.teams[String(team.id)] = {
      id: team.id, record: total ? { wins: total.wins, losses: total.losses, ties: total.ties,
        label: `${total.wins}-${total.losses}${total.ties ? `-${total.ties}` : ""}` } : null,
      standingRank: rank,
      division: division ? { id: division.id as number, name: clip(division.name), rank: oneDivision ? rank : null } : null,
      pointsFor: total?.pointsFor ?? null, pointsAgainst: total?.pointsAgainst ?? null,
      weeklyRank: final ? 1 + scores.filter((score) => cents(score) > cents(team.score)).length : null,
      weeklyRankTied: final && scores.filter((score) => cents(score) === cents(team.score)).length > 1,
      margin: completeIds.has(team.id) ? (cents(team.score) - cents(byId.get(team.opponentId)!.score)) / 100 : null,
    };
  }
  if (totals) {
    result.throughWeek = through;
    result.recordsBasis = officialRecordsMatch ? "ESPN records reconciled to completed matchups" : "Completed historical matchups";
    result.standingsBasis = seedsVerified ? "ESPN playoff seed" : null;
    result.note = `Records${seedsVerified ? " and ESPN seeding" : ""} are through Week ${through}.`
      + (result.currentWeek !== null && result.currentWeek !== through ? ` The saved league snapshot is in Week ${result.currentWeek}.` : "")
      + (!seedsVerified ? " Official seeding for this historical week could not be verified." : "");
  }
  return result;
}
