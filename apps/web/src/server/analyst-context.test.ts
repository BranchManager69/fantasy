import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bestLegalLineup, createAnalystContext } from "./analyst-context";
import type { WeekPlayer, WeekTeam } from "../lib/league-week";

function player(id: number, slotId: number, points: number | null, eligibleSlots: number[], starter = true): WeekPlayer {
  return { id, name: `Player ${id}`, position: "TEST", slot: String(slotId), slotId, points, eligibleSlots, starter };
}
function team(players: WeekPlayer[], opponentScore = 30): WeekTeam {
  const score = players.filter((p) => p.starter).reduce((sum, p) => sum + (p.points ?? 0), 0);
  return { id: 1, name: "Selected", opponentId: 2, opponentName: "Opponent", matchupId: 1, score, opponentScore,
    result: score > opponentScore ? "win" : "loss", final: true, players, lineupReconciled: true, starterTotal: score,
    allPlay: { wins: 0, losses: 1, ties: 0 } };
}
function opponent(score = 30): WeekTeam {
  return { ...team([player(99, 0, score, [0])]), id: 2, name: "Opponent", opponentId: 1 };
}

test("finds a winning complete lineup that every direct single swap misses", () => {
  const selected = team([
    player(1, 6, 0, [6, 23]), player(2, 23, 9, [6, 23]),
    player(3, 4, 10, [4, 23]), player(4, 20, 13, [4, 23], false),
  ], 30);
  const result = bestLegalLineup(selected, opponent(30), [6, 23, 4]);
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.optimal_score, 32);
  assert.equal(result.can_outscore_opponent, true);
  assert.deepEqual(result.promoted_bench.map((p) => p.id), [4]);
  assert.deepEqual(result.benched_starters.map((p) => p.id), [1]);
  assert.deepEqual(result.starter_slot_moves.map((s) => [s.player.id, s.from_slot_id, s.to_slot_id]), [[2, 23, 6]]);
  const directSwapScores = selected.players.filter((p) => p.starter && p.eligibleSlots.length)
    .filter((p) => selected.players[3].eligibleSlots.includes(p.slotId))
    .map((p) => selected.score - p.points! + 13);
  assert.ok(directSwapScores.every((score) => score < 30));
});

test("assigns overlapping position eligibility exactly and never duplicates a player", () => {
  const selected = team([
    player(1, 2, 1, [2, 23]), player(2, 23, 2, [4, 23]),
    player(3, 20, 20, [2, 23], false), player(4, 20, 19, [23], false),
  ]);
  const result = bestLegalLineup(selected, opponent());
  assert.ok(result.available);
  if (!result.available) return;
  assert.equal(result.optimal_score, 39);
  assert.deepEqual(result.lineup.map((s) => [s.slot_id, s.player.id]), [[2, 3], [23, 4]]);
  assert.equal(new Set(result.lineup.map((s) => s.player.id)).size, 2);
});

test("excludes reserve and IR even if they outscore every active player", () => {
  const selected = team([player(1, 0, 10, [0]), player(2, 20, 12, [0], false),
    player(3, 21, 100, [0], false), player(4, 25, 101, [0], false)]);
  const result = bestLegalLineup(selected, opponent());
  assert.ok(result.available);
  if (!result.available) return;
  assert.equal(result.optimal_score, 12);
  assert.equal(result.candidate_count, 2);
});

test("keeps complete negative-score lineups and distinguishes a points tie", () => {
  const result = bestLegalLineup(team([player(1, 0, -3, [0]), player(2, 2, -2, [2])]), opponent(-5));
  assert.ok(result.available);
  if (!result.available) return;
  assert.equal(result.optimal_score, -5);
  assert.equal(result.lineup.length, 2);
  assert.equal(result.points_comparison, "tied_on_points");
  assert.equal(result.can_outscore_opponent, false);
});

test("equal scores prefer the existing lineup and deterministic player IDs", () => {
  const selected = team([player(3, 4, 10, [4, 23]), player(2, 23, 10, [4, 23]), player(1, 20, 10, [4, 23], false)]);
  const result = bestLegalLineup(selected, opponent());
  assert.ok(result.available);
  if (!result.available) return;
  assert.deepEqual(result.changes, []);
  assert.deepEqual(bestLegalLineup({ ...selected, players: [...selected.players].reverse() }, opponent()), result);
});

test("declines a maximum claim for missing scores, duplicate IDs, or incomplete configured slots", () => {
  assert.equal(bestLegalLineup(team([player(1, 0, 10, [0]), player(2, 20, null, [0], false)]), opponent()).available, false);
  assert.equal(bestLegalLineup(team([player(1, 0, 10, [0]), player(1, 20, 20, [0], false)]), opponent()).available, false);
  assert.equal(bestLegalLineup(team([player(1, 0, 10, [0])]), opponent(), [0, 2]).available, false);
});

test("exact optimizer agrees with exhaustive assignment on varied overlapping rosters", () => {
  let randomState = 7;
  const random = () => { randomState = (randomState * 48271) % 2147483647; return randomState; };
  for (let iteration = 0; iteration < 40; iteration++) {
    const slots = [0, 2, 23];
    const players = slots.map((slot, i) => player(i + 1, slot, (random() % 30) - 5, [slot]));
    for (let i = 4; i <= 8; i++) players.push(player(i, 20, (random() % 30) - 5,
      slots.filter(() => random() % 2 === 0), false));
    let maximum = -Infinity;
    const enumerate = (index: number, used: Set<number>, score: number) => {
      if (index === slots.length) { maximum = Math.max(maximum, score); return; }
      for (const p of players) if (!used.has(p.id) && p.eligibleSlots.includes(slots[index])) {
        enumerate(index + 1, new Set([...used, p.id]), score + p.points!);
      }
    };
    enumerate(0, new Set(), 0);
    const result = bestLegalLineup(team(players), opponent());
    assert.ok(result.available);
    if (result.available) assert.equal(result.optimal_score, maximum);
  }
});

test("prefetches bounded evidence and exposes the same exact lineup through a no-argument tool", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fantasy-context-"));
  const previousRoot = process.env.DATA_ROOT;
  process.env.DATA_ROOT = directory;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = previousRoot;
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, "out/league/2026"), { recursive: true });
  await mkdir(path.join(directory, "raw/espn/2026"), { recursive: true });
  const selected = team([player(1, 0, 20, [0]), player(2, 20, 31, [0], false)]);
  await writeFile(path.join(directory, "out/league/2026/week_1.json"), JSON.stringify({
    season: 2026, week: 1, leagueName: "Fixture", generatedAt: new Date().toISOString(), complete: true,
    currentWeek: 2, sourceUrl: "https://fantasy.espn.com/football/league/scoreboard?leagueId=123",
    teams: [selected, opponent()], matchups: [{ id: 1, homeId: 1, awayId: 2, final: true }],
  }));
  await writeFile(path.join(directory, "raw/espn/2026/view-mMatchupScore-week-1.json"), JSON.stringify({
    seasonId: 2026, scoringPeriodId: 1, settings: { rosterSettings: { lineupSlotCounts: { 0: 1, 20: 1, 21: 2 } } },
    members: [{ displayName: "PRIVATE OWNER", email: "private@example.com" }],
  }));
  const context = await createAnalystContext(2026, 1, 1);
  const initial = JSON.parse(context.initialEvidence);
  assert.equal(initial.schema, "fantasy_analyst_initial_evidence");
  assert.equal(initial.version, 1);
  assert.deepEqual(initial.selection, { season: 2026, week: 1, teamId: 1, matchupId: 1 });
  assert.equal(initial.best_lineup.optimal_score, 31);
  assert.equal(initial.best_lineup.slots_verified_against_settings, true);
  assert.equal(initial.game_moments.available, false);
  assert.equal(context.initialEvidenceBytes, Buffer.byteLength(context.initialEvidence));
  assert.ok(context.initialEvidenceBytes <= 16 * 1024);
  assert.ok(!context.initialEvidence.includes("PRIVATE OWNER"));
  assert.ok(!context.initialEvidence.includes("private@example.com"));
  assert.ok(!context.initialEvidence.includes(directory));
  const full = await context.call("get_best_lineup", {}) as { optimal_score: number };
  assert.equal(full.optimal_score, initial.best_lineup.optimal_score);
  await assert.rejects(context.call("get_best_lineup", { path: "/etc/passwd" }), /no arguments/);
  await assert.rejects(context.call("get_league_timeline", { url: "https://example.com" }), /no arguments/);
  await rm(path.join(directory, "raw/espn/2026/view-mMatchupScore-week-1.json"));
  const missingSettings = JSON.parse((await createAnalystContext(2026, 1, 1)).initialEvidence);
  assert.equal(missingSettings.best_lineup.available, false);
  assert.match(missingSettings.best_lineup.reason, /cannot be proved/);
});
