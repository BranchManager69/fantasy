import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LeagueWeek, WeekMoments, WeekPlayer, WeekTeam } from "../lib/league-week";
import { buildWeekReplays } from "./week-replay";

const sourceUrl = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2026.csv.gz";
function player(id: number, slotId: number, points: number | null, eligibleSlots: number[], starter = true): WeekPlayer {
  return { id, name: `Synthetic Player ${id}`, position: "TEST", slot: ({ 0: "QB", 2: "RB", 4: "WR", 6: "TE", 20: "Bench", 23: "FLEX" } as Record<number, string>)[slotId] ?? "Reserve",
    slotId, points, eligibleSlots, starter };
}
function reportFixture(): LeagueWeek {
  const teams: WeekTeam[] = Array.from({ length: 14 }, (_, index) => {
    const id = index + 1, opponentId = id % 2 ? id + 1 : id - 1;
    const score = 10 + 2 * id, opponentScore = 10 + 2 * opponentId;
    return { id, name: `Synthetic Team ${id}`, opponentId, opponentName: `Synthetic Team ${opponentId}`,
      matchupId: Math.ceil(id / 2), score, opponentScore, result: score > opponentScore ? "win" : "loss", final: true,
      players: [player(id * 100 + 1, 0, 10 + id, [0]), player(id * 100 + 2, 2, id, [2]), player(id * 100 + 3, 20, 11 + id, [0], false)],
      lineupReconciled: true, starterTotal: score, allPlay: { wins: id - 1, losses: 14 - id, ties: 0 } };
  });
  return { season: 2026, week: 1, leagueName: "Synthetic League", generatedAt: "2026-09-16T00:00:00Z",
    complete: true, currentWeek: 2, sourceUrl: "https://fantasy.espn.com/football/league/scoreboard?leagueId=123",
    teams, matchups: Array.from({ length: 7 }, (_, i) => ({ id: i + 1, homeId: i * 2 + 1, awayId: i * 2 + 2, final: true })) };
}
function momentsFixture(): WeekMoments {
  return { season: 2026, week: 1,
    lead: { title: "A verified scoring play", summary: "Synthetic evidence fixture", player_name: "Synthetic Player 201", team_id: 2,
      quarter: 3, clock: "12:53", fantasy_points: 13, before: { "1": 12, "2": 0 }, after: { "1": 12, "2": 13 },
      source_url: sourceUrl, method_note: "Retrospective reconstruction from corrected plays and final player totals." },
    moments: [{ id: "synthetic-play", player_name: "Synthetic Player 201", team_id: 2, nfl_game_id: "2026_01_A_B",
      quarter: 3, clock: "12:53", description: "A synthetic 60-yard touchdown supplied by this test.", fantasy_points: 13,
      note: "Synthetic fixture", source_url: sourceUrl }] };
}
async function settings(t: TestContext, counts: Record<string, number> = { "0": 1, "2": 1, "20": 1 }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fantasy-week-replay-"));
  const prior = process.env.DATA_ROOT;
  process.env.DATA_ROOT = directory;
  t.after(async () => {
    if (prior === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = prior;
    await rm(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, "raw/espn/2026/view-mMatchupScore-week-1.json");
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify({ seasonId: 2026, scoringPeriodId: 1,
    settings: { rosterSettings: { lineupSlotCounts: counts } }, members: [{ email: "PRIVATE@example.test" }] }));
  return { directory, filename };
}

test("builds all 14 official matchups and attaches the verified play only to its exact pair", async (t) => {
  await settings(t);
  const report = reportFixture();
  const result = await buildWeekReplays(report, momentsFixture());
  assert.equal(Object.keys(result).length, 14);
  for (const team of report.teams) {
    const replay = result[String(team.id)];
    assert.equal(replay.team.score, team.score);
    assert.equal(replay.opponent.score, team.opponentScore);
    assert.equal(replay.team.final, true);
    assert.equal(replay.opponent.final, true);
    assert.deepEqual(replay.allPlay, team.allPlay);
    assert.equal(replay.bestLineup.available, true);
    assert.equal(replay.bestLineup.gain, 1);
    assert.equal(Boolean(replay.play), team.id === 1 || team.id === 2);
  }
  assert.deepEqual(result["1"].play, result["2"].play);
  assert.deepEqual(result["1"].play?.before, { "1": 12, "2": 0 });
  assert.deepEqual(result["1"].play?.after, { "1": 12, "2": 13 });
  assert.equal(result["2"].team.player?.id, 201);
  assert.equal(result["1"].opponent.player?.headshotUrl, "https://a.espncdn.com/i/headshots/nfl/players/full/201.png");
  assert.equal(result["14"].team.player?.id, 1401);
  assert.equal(result["1"].team.score, 12);
  assert.equal(result["2"].team.score, 14);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("the final scoreboard uses the top starter independently of the turning-point player", async (t) => {
  await settings(t);
  const report = reportFixture();
  report.teams[1].players[0].points = 6;
  report.teams[1].players[1].points = 8;
  report.teams[1].players[2].points = 99;
  const result = await buildWeekReplays(report, momentsFixture());
  assert.equal(result["2"].team.player?.id, 202);
  assert.equal(result["2"].team.player?.points, 8);
  assert.equal(result["1"].opponent.player?.id, 202);
  assert.equal(result["2"].play?.playerId, 201);
  assert.equal(result["1"].play?.playerId, 201);
  assert.equal(result["2"].play?.points, 13);
});

test("rejects wrong-week, mismatched-team, fabricated-delta and unlinked lead evidence", async (t) => {
  await settings(t);
  const mutations: ((moments: WeekMoments) => void)[] = [
    (m) => { m.season = 2025; }, (m) => { m.week = 2; },
    (m) => { m.lead!.before = { "2": 0, "3": 12 }; },
    (m) => { m.lead!.after["3"] = 5; },
    (m) => { m.lead!.after["2"] = 14; },
    (m) => { m.lead!.before["1"] = Number.NaN; },
    (m) => { m.lead!.player_name = "Synthetic Player 203"; },
    (m) => { m.moments = []; },
    (m) => { m.moments.push({ ...m.moments[0], id: "ambiguous-second-play" }); },
    (m) => { m.moments[0].clock = "12:52"; },
    (m) => { m.moments[0].fantasy_points = 12; },
    (m) => { m.lead!.source_url = "file:///private/source"; },
  ];
  for (const mutate of mutations) {
    const moments = momentsFixture(); mutate(moments);
    const result = await buildWeekReplays(reportFixture(), moments);
    assert.equal(result["1"].play, undefined);
    assert.equal(result["2"].play, undefined);
    assert.equal(result["1"].team.score, 12);
  }
});

test("future or nonfinal results never receive final labels, all-play records or lineup claims", async (t) => {
  await settings(t);
  const report = reportFixture(); report.currentWeek = 0;
  const future = await buildWeekReplays(report, momentsFixture());
  for (const replay of Object.values(future)) {
    assert.equal(replay.team.final, false);
    assert.equal(replay.opponent.final, false);
    assert.equal(replay.play, undefined);
    assert.equal(replay.allPlay, null);
    assert.equal(replay.bestLineup.available, false);
  }
  report.currentWeek = 1; report.complete = false; report.teams[0].final = false;
  const partial = await buildWeekReplays(report, momentsFixture());
  assert.equal(partial["1"].team.final, false);
  assert.equal(partial["2"].team.final, false);
  assert.equal(partial["3"].team.final, true);
  assert.ok(Object.values(partial).every((replay) => replay.allPlay === null));
});

test("exposes coordinated complete-lineup changes with actual IDs, destinations and point margins", async (t) => {
  await settings(t, { "4": 1, "6": 1, "23": 1, "20": 1, "21": 1 });
  const report = reportFixture();
  Object.assign(report.teams[0], { score: 19, starterTotal: 19, opponentScore: 30,
    players: [player(1, 6, 0, [6, 23]), player(2, 23, 9, [6, 23]), player(3, 4, 10, [4, 23]),
      player(4, 20, 13, [4, 23], false), player(5, 21, 100, [4, 23], false)] });
  Object.assign(report.teams[1], { score: 30, starterTotal: 30, opponentScore: 19,
    players: [player(21, 6, 5, [6]), player(22, 4, 10, [4]), player(23, 23, 15, [23])] });
  const result = (await buildWeekReplays(report, null))["1"].bestLineup;
  assert.equal(result.available, true);
  assert.equal(result.retrospective, true);
  assert.equal(result.score, 32);
  assert.equal(result.gain, 13);
  assert.equal(result.margin, 2);
  assert.deepEqual(result.moves.map(({ id, from, to, points }) => ({ id, from, to, points })), [
    { id: 1, from: "TE", to: "Bench", points: 0 },
    { id: 2, from: "FLEX", to: "TE", points: 9 },
    { id: 4, from: "Bench", to: "FLEX", points: 13 },
  ]);
  assert.match(result.caveat, /final points/);
  assert.ok(!result.moves.some((move) => move.id === 5));
});

test("a points tie stays numeric without claiming an official win", async (t) => {
  await settings(t);
  const report = reportFixture(); report.teams[0].players[2].points = 13;
  const result = (await buildWeekReplays(report, null))["1"].bestLineup;
  assert.equal(result.available, true);
  assert.equal(result.score, 14);
  assert.equal(result.margin, 0);
  assert.match(result.caveat, /tiebreaks are not simulated/);
  assert.equal("win" in result, false);
});

test("missing eligibility or final scores withdraw the maximum while retaining official results", async (t) => {
  await settings(t);
  for (const mutate of [
    (team: WeekTeam) => { team.players[2].eligibleSlots = []; },
    (team: WeekTeam) => { team.players[2].points = null; },
    (team: WeekTeam) => { team.lineupReconciled = false; },
  ]) {
    const report = reportFixture(); mutate(report.teams[0]);
    const result = (await buildWeekReplays(report, null))["1"];
    assert.equal(result.bestLineup.available, false);
    assert.ok(result.bestLineup.reason);
    assert.equal(result.bestLineup.score, undefined);
    assert.deepEqual(result.bestLineup.moves, []);
    assert.equal(result.team.score, 12);
    assert.equal(result.team.final, true);
  }
});

test("missing, wrong-period, malformed and symlinked settings fail closed without dropping teams", async (t) => {
  const { directory, filename } = await settings(t);
  for (const contents of ["{}", "{", JSON.stringify({ seasonId: 2026, scoringPeriodId: 2, settings: { rosterSettings: { lineupSlotCounts: { "0": 1, "2": 1 } } } })]) {
    await writeFile(filename, contents);
    const result = await buildWeekReplays(reportFixture(), null);
    assert.equal(Object.keys(result).length, 14);
    assert.ok(Object.values(result).every((replay) => !replay.bestLineup.available && replay.team.final));
  }
  await rm(filename);
  assert.equal((await buildWeekReplays(reportFixture(), null))["1"].bestLineup.available, false);
  const target = path.join(directory, "other.json");
  await writeFile(target, JSON.stringify({ seasonId: 2026, scoringPeriodId: 1, settings: { rosterSettings: { lineupSlotCounts: { "0": 1, "2": 1 } } } }));
  await symlink(target, filename);
  assert.equal((await buildWeekReplays(reportFixture(), null))["1"].bestLineup.available, false);
});

test("missing configured starters and inconsistent opponents cannot claim an exact replay", async (t) => {
  await settings(t, { "0": 1, "2": 2 });
  const report = reportFixture();
  const incomplete = (await buildWeekReplays(report, momentsFixture()))["1"];
  assert.equal(incomplete.bestLineup.available, false);
  assert.match(incomplete.bestLineup.reason!, /configured lineup slots/);
  report.teams[1].opponentId = 3;
  const inconsistent = (await buildWeekReplays(report, momentsFixture()))["1"];
  assert.equal(inconsistent.team.final, false);
  assert.equal(inconsistent.play, undefined);
  assert.equal(inconsistent.bestLineup.available, false);
  report.teams = report.teams.filter((team) => team.id !== 2);
  const missing = (await buildWeekReplays(report, null))["1"];
  assert.equal(missing.opponent.id, 2);
  assert.equal(missing.opponent.score, 14);
  assert.equal(missing.opponent.player, null);
  assert.equal(missing.opponent.final, false);
});

test("the public payload excludes raw owners, private paths and arbitrary extra source fields", async (t) => {
  const { directory } = await settings(t);
  const report = reportFixture();
  const moments = momentsFixture();
  Object.assign(report.teams[0], { owner: "PRIVATE OWNER", cookies: "PRIVATE COOKIE" });
  Object.assign(moments.lead!, { source_refs: { historical_roster: "/private/raw.json" }, secret: "PRIVATE SECRET" });
  const text = JSON.stringify(await buildWeekReplays(report, moments));
  for (const forbidden of ["PRIVATE", "private/raw", directory, "members", "source_refs", "cookies"]) assert.ok(!text.includes(forbidden));
});

test("invalid selection and duplicate team IDs return an empty map without reading arbitrary paths", async (t) => {
  await settings(t);
  const report = reportFixture();
  assert.deepEqual(await buildWeekReplays({ ...report, season: "../private" as unknown as number }, null), {});
  assert.deepEqual(await buildWeekReplays({ ...report, week: 19 }, null), {});
  report.teams.push({ ...report.teams[0] });
  assert.deepEqual(await buildWeekReplays(report, null), {});
});
