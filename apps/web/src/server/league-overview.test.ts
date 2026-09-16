import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LeagueWeek, WeekTeam } from "../lib/league-week";
import { buildLeagueOverview } from "./league-overview";

function reportFixture(): LeagueWeek {
  const scores = [100, 90, 80, 80];
  const teams: WeekTeam[] = scores.map((score, index) => {
    const id = index + 1, opponentId = id % 2 ? id + 1 : id - 1;
    const opponentScore = scores[opponentId - 1];
    return { id, name: `Synthetic team ${id}`, score, opponentId, opponentName: `Synthetic team ${opponentId}`,
      opponentScore, matchupId: Math.ceil(id / 2), final: true,
      result: score > opponentScore ? "win" : score < opponentScore ? "loss" : "tie",
      players: [], lineupReconciled: true, starterTotal: score, allPlay: null };
  });
  return { season: 2026, week: 1, currentWeek: 2, leagueName: "Synthetic league", complete: true,
    generatedAt: "2026-09-16T00:00:00Z", sourceUrl: "https://fantasy.espn.com/football/league/scoreboard?leagueId=123&seasonId=2026&matchupPeriodId=1",
    teams, matchups: [{ id: 1, homeId: 1, awayId: 2, final: true }, { id: 2, homeId: 3, awayId: 4, final: true }] };
}
function snapshotFixture(report = reportFixture()) {
  return { id: 123, seasonId: 2026, scoringPeriodId: 1,
    status: { currentMatchupPeriod: 2 },
    settings: { scheduleSettings: { matchupPeriodLength: 1, matchupPeriodCount: 14,
      matchupPeriods: { "1": [1], "2": [2] }, divisions: [{ id: 0, name: "East" }] } },
    teams: report.teams.map((team, index) => ({ id: team.id, divisionId: 0, playoffSeed: [1, 4, 2, 3][index],
      rankCalculatedFinal: 0, currentProjectedRank: index + 5, owners: ["PRIVATE OWNER"],
      record: { overall: { wins: Number(team.result === "win"), losses: Number(team.result === "loss"), ties: Number(team.result === "tie"),
        pointsFor: team.score, pointsAgainst: team.opponentScore } } })),
    schedule: report.matchups.map((match) => {
      const home = report.teams.find((team) => team.id === match.homeId)!;
      const away = report.teams.find((team) => team.id === match.awayId)!;
      return { id: match.id, matchupPeriodId: 1, winner: home.result === "win" ? "HOME" : home.result === "loss" ? "AWAY" : "TIE",
        home: { teamId: home.id, totalPoints: home.score }, away: { teamId: away.id, totalPoints: away.score } };
    }), members: [{ email: "PRIVATE@example.test" }] };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fantasy-overview-"));
  const prior = process.env.DATA_ROOT;
  process.env.DATA_ROOT = directory;
  t.after(async () => {
    if (prior === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = prior;
    await rm(directory, { recursive: true, force: true });
  });
  const folder = path.join(directory, "raw/espn/2026");
  await mkdir(folder, { recursive: true });
  const filename = path.join(folder, "view-mMatchupScore-week-1.json");
  await writeFile(filename, JSON.stringify(snapshotFixture()));
  return { directory, folder, filename, write: (value: unknown) => writeFile(filename, JSON.stringify(value)) };
}

test("reconciles actual records and ESPN seeding while keeping weekly score ranks separate", async (t) => {
  await fixture(t);
  const result = await buildLeagueOverview(reportFixture());
  assert.equal(result.final, true);
  assert.equal(result.throughWeek, 1);
  assert.equal(result.currentWeek, 2);
  assert.equal(result.recordsBasis, "ESPN records reconciled to completed matchups");
  assert.equal(result.standingsBasis, "ESPN playoff seed");
  assert.deepEqual(result.teams["1"].record, { wins: 1, losses: 0, ties: 0, label: "1-0" });
  assert.equal(result.teams["2"].record?.label, "0-1");
  assert.equal(result.teams["3"].record?.label, "0-0-1");
  assert.equal(result.teams["2"].standingRank, 4);
  assert.equal(result.teams["2"].weeklyRank, 2);
  assert.equal(result.teams["2"].pointsFor, 90);
  assert.equal(result.teams["2"].pointsAgainst, 100);
  assert.equal(result.teams["2"].margin, -10);
  assert.deepEqual(result.teams["2"].division, { id: 0, name: "East", rank: 4 });
  assert.match(result.note, /through Week 1/);
  assert.match(result.note, /snapshot is in Week 2/);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("weekly ties share competition rank and extrema include every tied team on one score scale", async (t) => {
  await fixture(t);
  const result = await buildLeagueOverview(reportFixture());
  assert.deepEqual(Object.values(result.teams).map((team) => [team.weeklyRank, team.weeklyRankTied]), [[1, false], [2, false], [3, true], [3, true]]);
  assert.deepEqual(result.aggregate, { teamCount: 4, completedMatchups: 2, totalMatchups: 2,
    high: { score: 100, teamIds: [1] }, low: { score: 80, teamIds: [3, 4] }, median: 85, scale: { min: 0, max: 100 } });
  const report = reportFixture();
  report.teams[0].score = 90; report.teams[1].opponentScore = 90;
  report.teams[0].result = "tie"; report.teams[1].result = "tie";
  const tiedHigh = await buildLeagueOverview(report);
  assert.deepEqual(tiedHigh.aggregate.high, { score: 90, teamIds: [1, 2] });
  assert.deepEqual(Object.values(tiedHigh.teams).map((team) => team.weeklyRank), [1, 1, 3, 3]);
});

test("missing raw data retains verified first-week records without inventing season standings", async (t) => {
  const { filename } = await fixture(t); await rm(filename);
  const result = await buildLeagueOverview(reportFixture());
  assert.equal(result.recordsBasis, "Completed historical matchups");
  assert.equal(result.standingsBasis, null);
  assert.equal(result.teams["1"].standingRank, null);
  assert.equal(result.teams["1"].record?.label, "1-0");
  assert.equal(result.teams["1"].pointsFor, 100);
  assert.equal(result.teams["1"].division, null);
});

test("later cumulative records cannot leak current standings into an earlier week", async (t) => {
  const f = await fixture(t); const snapshot = snapshotFixture();
  for (const team of snapshot.teams) { team.record.overall.wins++; team.record.overall.pointsFor += 120; }
  await f.write(snapshot);
  const result = await buildLeagueOverview(reportFixture());
  assert.equal(result.throughWeek, 1);
  assert.equal(result.teams["1"].record?.label, "1-0");
  assert.equal(result.teams["1"].pointsFor, 100);
  assert.equal(result.standingsBasis, null);
  assert.ok(Object.values(result.teams).every((team) => team.standingRank === null));
});

test("incomplete current and future weeks retain prior records without final weekly statistics", async (t) => {
  const f = await fixture(t); const snapshot = snapshotFixture();
  snapshot.scoringPeriodId = 2;
  await writeFile(path.join(f.folder, "league-snapshot.json"), JSON.stringify(snapshot));
  const report = reportFixture(); report.week = 2; report.complete = false;
  report.teams.forEach((team) => { team.final = false; team.score = 0; team.opponentScore = 0; });
  report.matchups.forEach((match) => { match.final = false; });
  for (const week of [2, 3]) {
    report.week = week;
    const result = await buildLeagueOverview(report);
    assert.equal(result.final, false);
    assert.equal(result.throughWeek, 1);
    assert.equal(result.teams["1"].record?.label, "1-0");
    assert.equal(result.aggregate.completedMatchups, 0);
    assert.equal(result.aggregate.high, null);
    assert.equal(result.aggregate.low, null);
    assert.equal(result.aggregate.median, null);
    assert.ok(Object.values(result.teams).every((team) => team.weeklyRank === null && team.margin === null));
  }
});

test("unverified seeds and multiple divisions never produce guessed standings or division ranks", async (t) => {
  const f = await fixture(t); const snapshot = snapshotFixture();
  snapshot.teams[1].playoffSeed = 1;
  await f.write(snapshot);
  let result = await buildLeagueOverview(reportFixture());
  assert.equal(result.standingsBasis, null);
  assert.ok(Object.values(result.teams).every((team) => team.standingRank === null && team.division?.rank === null));
  snapshot.teams[1].playoffSeed = 4;
  snapshot.settings.scheduleSettings.divisions.push({ id: 1, name: "West" });
  snapshot.teams[2].divisionId = 1; snapshot.teams[3].divisionId = 1;
  await f.write(snapshot);
  result = await buildLeagueOverview(reportFixture());
  assert.equal(result.standingsBasis, "ESPN playoff seed");
  assert.equal(result.teams["3"].division?.name, "West");
  assert.ok(Object.values(result.teams).every((team) => team.division?.rank === null));
});

test("wrong league, season, period and malformed snapshots cannot supply historical standings", async (t) => {
  const f = await fixture(t);
  for (const patch of [{ id: 456 }, { seasonId: 2025 }, { scoringPeriodId: 2 }]) {
    await f.write({ ...snapshotFixture(), ...patch });
    const result = await buildLeagueOverview(reportFixture());
    assert.equal(result.standingsBasis, null);
    assert.equal(result.teams["1"].record?.label, "1-0");
  }
  await writeFile(f.filename, "{");
  assert.equal((await buildLeagueOverview(reportFixture())).standingsBasis, null);
  await rm(f.filename);
  const target = path.join(f.directory, "other.json"); await writeFile(target, JSON.stringify(snapshotFixture()));
  await symlink(target, f.filename);
  assert.equal((await buildLeagueOverview(reportFixture())).standingsBasis, null);
});

test("season totals require every completed historical week and reject unresolved results", async (t) => {
  const f = await fixture(t); const snapshot = snapshotFixture();
  const report = reportFixture(); report.week = 2;
  snapshot.scoringPeriodId = 2;
  await writeFile(path.join(f.folder, "view-mMatchupScore-week-2.json"), JSON.stringify(snapshot));
  let result = await buildLeagueOverview(report);
  assert.equal(result.recordsBasis, null);
  assert.ok(Object.values(result.teams).every((team) => team.record === null && team.pointsFor === null));
  snapshot.schedule.push(...snapshot.schedule.map((match) => ({ ...match, matchupPeriodId: 2, winner: "UNDECIDED" })));
  await writeFile(path.join(f.folder, "view-mMatchupScore-week-2.json"), JSON.stringify(snapshot));
  result = await buildLeagueOverview(report);
  assert.equal(result.recordsBasis, null);
});

test("a cumulative two-week record is built from both completed weeks and checked against ESPN", async (t) => {
  const f = await fixture(t); const snapshot = snapshotFixture();
  const report = reportFixture(); report.week = 2; report.currentWeek = 3;
  snapshot.scoringPeriodId = 2;
  snapshot.schedule.push(...snapshot.schedule.map((match) => ({ ...match, matchupPeriodId: 2 })));
  for (const team of snapshot.teams) for (const key of ["wins", "losses", "ties", "pointsFor", "pointsAgainst"] as const) team.record.overall[key] *= 2;
  await writeFile(path.join(f.folder, "view-mMatchupScore-week-2.json"), JSON.stringify(snapshot));
  const result = await buildLeagueOverview(report);
  assert.equal(result.throughWeek, 2);
  assert.equal(result.recordsBasis, "ESPN records reconciled to completed matchups");
  assert.equal(result.teams["1"].record?.label, "2-0");
  assert.equal(result.teams["1"].pointsFor, 200);
  assert.equal(result.teams["2"].pointsAgainst, 200);
  assert.equal(result.teams["3"].record?.label, "0-0-2");
});

test("shared score scales include negative scores, and inconsistent pairs withhold final aggregates", async (t) => {
  await fixture(t);
  const report = reportFixture(); report.teams[0].score = -3.2; report.teams[1].opponentScore = -3.2;
  report.teams[0].result = "loss"; report.teams[1].result = "win";
  const result = await buildLeagueOverview(report);
  assert.deepEqual(result.aggregate.scale, { min: -10, max: 90 });
  assert.equal(result.teams["1"].margin, -93.2);
  report.teams[1].opponentScore = 999;
  const inconsistent = await buildLeagueOverview(report);
  assert.equal(inconsistent.final, false);
  assert.equal(inconsistent.aggregate.completedMatchups, 1);
  assert.equal(inconsistent.aggregate.high, null);
  assert.equal(inconsistent.teams["1"].margin, null);
});

test("outputs only public overview fields and rejects invalid selections without path traversal", async (t) => {
  const { directory } = await fixture(t);
  const report = reportFixture();
  Object.assign(report.teams[0], { email: "PRIVATE@example.test" });
  const output = JSON.stringify(await buildLeagueOverview(report));
  assert.ok(!output.includes("PRIVATE")); assert.ok(!output.includes(directory));
  assert.ok(!output.includes("owners")); assert.ok(!output.includes("currentProjectedRank"));
  const invalid = await buildLeagueOverview({ ...report, season: "../private" as unknown as number });
  assert.deepEqual(invalid.teams, {});
  assert.equal(invalid.aggregate.high, null);
  report.teams.push({ ...report.teams[0] });
  assert.deepEqual((await buildLeagueOverview(report)).teams, {});
});
