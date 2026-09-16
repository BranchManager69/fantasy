import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LeagueWeek, WeekPlayer, WeekTeam } from "../lib/league-week";
import type { StudioState, StudioProfile, StudioMemory } from "./league-studio-store";
import { prepareInterviewBrief } from "./interview-brief";

const selection = { season: 2027, week: 2, teamId: 91 };
const date = "2027-09-21T06:00:00+00:00";
function player(id: number, slotId: number, points: number, eligibleSlots: number[], starter = true): WeekPlayer {
  return { id, name: `Football Player ${id}`, position: "TEST", slot: String(slotId), slotId, points, eligibleSlots, starter };
}
function team(id: number, opponentId: number, matchupId: number, score: number, opponentScore: number, players: WeekPlayer[]): WeekTeam {
  return { id, opponentId, matchupId, name: `Team ${id}`, opponentName: `Team ${opponentId}`,
    score, opponentScore, result: score > opponentScore ? "win" : "loss", final: true,
    lineupReconciled: true, starterTotal: score, players,
    allPlay: { wins: [33, 20, 19, 10].filter((value) => value < score).length,
      losses: [33, 20, 19, 10].filter((value) => value > score).length, ties: 0 } };
}
function profile(id: string, teamId: number): StudioProfile {
  return { id, teamId, displayName: id, aliases: [`${id}-account-one`, `${id}-account-two`],
    background: `Saved background for ${id}`, roastNotes: "", avoidTopics: [] };
}
function memory(id: string, memberIds: string[], confidence: "explicit" | "inferred" = "explicit", enabled = true): StudioMemory {
  return { id, kind: "running_joke", text: `Saved joke ${id}`, memberIds, sourceIds: [`source-${id}`],
    confidence, enabled, importId: "source-import", createdAt: date, updatedAt: date };
}

async function fixture(t: TestContext, mutate?: (report: LeagueWeek) => void, state?: StudioState) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fantasy-interview-"));
  const previousRoot = process.env.DATA_ROOT;
  process.env.DATA_ROOT = directory;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = previousRoot;
    await rm(directory, { recursive: true, force: true });
  });
  const report: LeagueWeek = { ...selection, leagueName: "Fixture Football League", generatedAt: date,
    complete: true, currentWeek: 3, sourceUrl: "https://fantasy.espn.com/football/league/scoreboard?leagueId=123",
    teams: [team(91, 92, 1, 19, 33, [player(10, 6, 0, [6, 23]), player(20, 23, 9, [6, 23]),
      player(30, 4, 10, [4, 23]), player(40, 20, 13, [4, 23], false)]),
    team(92, 91, 1, 33, 19, [player(50, 6, 11, [6]), player(60, 23, 11, [23]), player(70, 4, 11, [4])]),
    team(93, 94, 2, 20, 10, [player(80, 6, 20, [6])]),
    team(94, 93, 2, 10, 20, [player(90, 6, 10, [6])])],
    matchups: [{ id: 1, homeId: 91, awayId: 92, final: true }, { id: 2, homeId: 93, awayId: 94, final: true }] };
  mutate?.(report);
  await mkdir(path.join(directory, "out/league/2027"), { recursive: true });
  await mkdir(path.join(directory, "raw/espn/2027"), { recursive: true });
  await writeFile(path.join(directory, "out/league/2027/week_2.json"), JSON.stringify(report));
  await writeFile(path.join(directory, "raw/espn/2027/view-mMatchupScore-week-2.json"), JSON.stringify({
    id: 123, seasonId: 2027, scoringPeriodId: 2,
    settings: { rosterSettings: { lineupSlotCounts: { 6: 1, 23: 1, 4: 1, 20: 1 } } },
  }));
  if (state) {
    await mkdir(path.join(directory, "private/studio"), { recursive: true });
    await writeFile(path.join(directory, "private/studio/state.json"), JSON.stringify(state));
  }
  return { directory, report };
}

test("prepares from the selected historical week and retains the full-lineup counterfactual", async (t) => {
  await fixture(t, (report) => { report.teams[0].allPlay = { wins: 3, losses: 0, ties: 0 }; });
  const prepared = await prepareInterviewBrief(selection);
  const brief = prepared.brief;
  assert.deepEqual(brief.selection, selection);
  assert.equal(brief.selected.score, 19);
  assert.equal(brief.opponent.score, 33);
  assert.equal(brief.margin, -14);
  assert.equal(brief.bestLineup.optimal_score, 32);
  assert.equal(brief.bestLineup.margin, -1);
  assert.equal(brief.bestLineup.can_outscore_opponent, false);
  assert.deepEqual((brief.bestLineup.promoted_bench as { id: number }[]).map((entry) => entry.id), [40]);
  assert.deepEqual((brief.bestLineup.starter_slot_moves as { player: { id: number } }[]).map((entry) => entry.player.id), [20]);
  assert.equal(brief.weeklyContext.rank, 3);
  assert.deepEqual(brief.weeklyContext.allPlay, { wins: 1, losses: 2, ties: 0 });
  assert.equal(brief.weeklyContext.standingRank, null);
  assert.equal(brief.owners.addressee.status, "unmapped");
  assert.match(String(brief.bestLineup.caveat), /does not reconstruct kickoff locks/);
  assert.deepEqual(JSON.parse(prepared.initialEvidence), brief);
  assert.ok(Buffer.byteLength(prepared.initialEvidence) <= 32 * 1024);
  const voiceFacts = JSON.parse(prepared.voiceInstructions.slice(prepared.voiceInstructions.lastIndexOf("\n") + 1));
  assert.equal(voiceFacts.bestLineup.optimalScore, 32);
  assert.equal(voiceFacts.bestLineup.signedMargin, -1);
  assert.equal(voiceFacts.selected.score, 19);
  assert.equal(voiceFacts.opponent.score, 33);
  assert.equal(voiceFacts.weeklyContext.rank, 3);
  assert.ok(!prepared.voiceInstructions.includes("112.3"));
  assert.ok(!prepared.voiceInstructions.includes("126.9"));
  assert.ok(!prepared.voiceInstructions.includes("Dexter"));
});

test("follow-up tools preserve fixed selection and return the same verified lineup", async (t) => {
  await fixture(t);
  const prepared = await prepareInterviewBrief(selection);
  const lineup = await prepared.call("get_best_lineup", {}) as { optimal_score: number; team_id: number; week: number };
  assert.equal(lineup.optimal_score, prepared.brief.bestLineup.optimal_score);
  assert.equal(lineup.team_id, 91);
  assert.equal(lineup.week, 2);
  assert.deepEqual(await prepared.call("get_interview_brief", {}), prepared.brief);
  await assert.rejects(prepared.call("get_best_lineup", { teamId: 92 }), /no arguments/);
  await assert.rejects(prepared.call("get_owner_context", { memberId: "stranger" }), /no arguments/);
  await assert.rejects(prepared.call("call_someone_else", {}), /Unknown league evidence tool/);
});

test("a pending or unreconciled matchup cannot become a postgame call", async (t) => {
  const { directory, report } = await fixture(t, (value) => { value.teams[0].final = false; });
  await assert.rejects(prepareInterviewBrief(selection), /requires final, reconciled/);
  report.teams[0].final = true;
  report.teams[0].lineupReconciled = false;
  await writeFile(path.join(directory, "out/league/2027/week_2.json"), JSON.stringify(report));
  await assert.rejects(prepareInterviewBrief(selection), /requires final, reconciled/);
});

test("missing play evidence and an unfinished league do not become invented drama or rankings", async (t) => {
  await fixture(t, (value) => {
    value.complete = false;
    value.teams[2].final = false;
    value.teams[3].final = false;
    value.matchups[1].final = false;
  });
  const { brief } = await prepareInterviewBrief(selection);
  assert.equal(brief.final, true);
  assert.equal(brief.gameMoments.available, false);
  assert.equal(brief.weeklyContext.complete, false);
  assert.equal(brief.weeklyContext.rank, null);
  assert.equal(brief.weeklyContext.allPlay, null);
  assert.ok(!brief.questionAngles.some((angle) => angle.topic === "game_moment" || angle.topic === "schedule_luck"));
});

test("owner context keeps co-owners distinct, treats aliases as accounts, and excludes unrelated or inferred memories", async (t) => {
  const state: StudioState = { schema: 1, updatedAt: date, imports: [],
    profiles: [profile("first-owner", 91), profile("second-owner", 91), profile("opponent-owner", 92), profile("stranger", 93)],
    memories: [memory("matched", ["first-owner", "opponent-owner"]), memory("unrelated", ["stranger"]),
      memory("mixed", ["first-owner", "stranger"]), memory("inferred", ["first-owner"], "inferred"),
      memory("disabled", ["first-owner"], "explicit", false)] };
  await fixture(t, undefined, state);
  const { brief, voiceInstructions } = await prepareInterviewBrief(selection);
  assert.equal(brief.owners.addressee.status, "multiple_owners");
  assert.equal(brief.owners.addressee.name, null);
  assert.deepEqual(brief.owners.selectedOwners.map((person) => person.id), ["first-owner", "second-owner"]);
  assert.deepEqual(brief.owners.memories.map((entry) => entry.id), ["matched"]);
  assert.ok(!JSON.stringify(brief.owners).includes("stranger"));
  assert.ok(!voiceInstructions.includes("Saved background"));
  assert.ok(!voiceInstructions.includes("Saved joke"));
});

test("a sole owner is named once even with multiple account aliases", async (t) => {
  await fixture(t, undefined, { schema: 1, updatedAt: date, imports: [], memories: [], profiles: [profile("single-owner", 91)] });
  const { brief } = await prepareInterviewBrief(selection);
  assert.equal(brief.owners.addressee.status, "single_owner");
  assert.equal(brief.owners.addressee.memberId, "single-owner");
  assert.equal(brief.owners.selectedOwners.length, 1);
});
