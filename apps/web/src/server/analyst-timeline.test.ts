import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLeagueTimeline, compactLeagueTimeline } from "./analyst-timeline";
import type { LeagueWeek, WeekPlayer, WeekTeam } from "../lib/league-week";

type Row = Record<string, string>;
const player = (id: number, points: number): WeekPlayer => ({ id, name: `Player ${id}`, position: "RB", slot: "RB",
  slotId: 2, eligibleSlots: [2], starter: true, points });
const team = (id: number, points: number, players = [player(id, points)]): WeekTeam => ({ id, name: `Team ${id}`,
  opponentId: id === 1 ? 2 : 1, opponentName: `Team ${id === 1 ? 2 : 1}`, matchupId: 1, score: points,
  opponentScore: 10, result: "win", final: true, players, lineupReconciled: true, starterTotal: points, allPlay: null });
function report(): LeagueWeek {
  return { season: 2030, week: 4, leagueName: "Fixture", generatedAt: "2030-10-01T00:00:00Z", complete: true,
    currentWeek: 5, sourceUrl: "https://fantasy.espn.com/football/league/scoreboard?leagueId=1",
    teams: [team(1, 10), team(2, 20)], matchups: [{ id: 1, homeId: 1, awayId: 2, final: true }] };
}
const mapping = [{ espn_id: "1", gsis_id: "p1" }, { espn_id: "2", gsis_id: "p2" }];
function play(game: string, id: number, playerId: string, time: string, override: Row = {}): Row {
  return { season: "2030", week: "4", season_type: "REG", game_id: game, game_date: game.includes("AAA") ? "2030-09-29" : "2030-09-30",
    play_id: String(id), time_of_day: time, qtr: "3", time: "12:00", desc: "A verified scoring play.", play_type: "run",
    rusher_player_id: playerId, touchdown: "1", interception: "0", fumble_lost: "0", yards_gained: "40", ...override };
}
const early = "2030_04_AAA_BBB", late = "2030_04_CCC_DDD";
function rows(): Row[] {
  return [play(early, 1, "p1", "2030-09-29T17:00:00Z", { yards_gained: "90" }),
    play(early, 2, "", "", { desc: "END GAME", touchdown: "0", yards_gained: "0" }),
    play(late, 1, "p2", "2030-10-01T00:00:00Z"),
    play(late, 2, "", "", { desc: "END GAME", touchdown: "0", yards_gained: "0" })];
}

test("orders candidates by observed event and yardage without favoring the latest game", () => {
  const timeline = buildLeagueTimeline(report(), mapping, rows().reverse());
  assert.equal(timeline.selectedFeature?.candidate_id, `${early}:1`);
  assert.equal(timeline.selectedFeature?.player_name, "Player 1");
  assert.equal(timeline.selectedFeature?.evidence_kind, "nfl_play_only");
  assert.equal(timeline.selectedFeature?.fantasy_points, undefined);
  assert.deepEqual(timeline.moments.map((p) => p.id), [`${early}:1`, `${late}:1`]);
  assert.equal(timeline.coverage.historical_starters, 2);
  assert.equal(timeline.coverage.starters_with_observed_games, 2);
  assert.equal(timeline.matchups[0].teams[0].completed_points_before_latest_game, 10);
  assert.equal(timeline.matchups[0].teams[1].completed_points_before_latest_game, 0);
  assert.equal(timeline.matchups[0].teams[1].remaining_starters[0].id, 2);
  assert.equal(timeline.matchups_with_players_in_latest_window, 1);
  assert.ok(timeline.caveat.includes("do not mean a matchup was undecided"));
  assert.ok(timeline.ranking_method.includes("no day-of-week or recency bonus"));
  assert.ok(timeline.ranking_method.includes("not fantasy-point values"));
  assert.equal(timeline.rankedCandidates[0].editorial_score, 100.9);
  assert.equal(timeline.rankedCandidates[1].editorial_score, 100.4);
});

test("identical NFL events receive identical priority regardless of day or clock", () => {
  const data = rows();
  data[2].yards_gained = "90";
  const timeline = buildLeagueTimeline(report(), mapping, data);
  assert.equal(timeline.rankedCandidates[0].editorial_score, timeline.rankedCandidates[1].editorial_score);
  assert.equal(timeline.rankedCandidates[0].id, `${early}:1`); // Stable ID breaks ties, not recency.
});

test("a pick-six is a turnover for the throwing quarterback, never an offensive touchdown", () => {
  const pickSix = play(early, 10, "", "2030-09-29T17:30:00Z", {
    play_type: "pass", passer_player_id: "p1", receiver_player_id: "p2", touchdown: "1", interception: "1", yards_gained: "0",
    desc: "A synthetic pass is intercepted and returned for a defensive touchdown.",
  });
  const timeline = buildLeagueTimeline(report(), mapping, [pickSix]);
  assert.equal(timeline.rankedCandidates[0].event_type, "turnover");
  assert.equal(timeline.rankedCandidates[0].editorial_score, 90);
  assert.equal(timeline.selectedFeature?.player_name, "Player 1");
  assert.match(timeline.selectedFeature!.title, /turnover/);
  assert.ok(!timeline.selectedFeature!.title.includes("touchdown"));
  assert.equal(timeline.selectedFeature?.fantasy_points, undefined);
});

test("a lost fumble returned for a touchdown keeps turnover precedence", () => {
  const timeline = buildLeagueTimeline(report(), mapping, [play(early, 10, "p1", "2030-09-29T17:30:00Z", {
    touchdown: "1", fumble_lost: "1", fumbled_1_player_id: "p1", yards_gained: "3",
  })]);
  assert.equal(timeline.rankedCandidates[0].event_type, "turnover");
  assert.equal(timeline.rankedCandidates[0].editorial_score, 90.03);
});

test("does not invent a same-day completion time from an untimed END GAME marker", () => {
  const data = rows();
  data[0].game_date = data[1].game_date = "2030-09-30";
  data[0].time_of_day = "2030-09-30T21:00:00Z";
  const timeline = buildLeagueTimeline(report(), mapping, data);
  assert.equal(timeline.games[0].has_end_game_marker, true);
  assert.equal(timeline.matchups[0].timing_coverage_complete, false);
  assert.equal(timeline.matchups[0].teams[0].completed_points_before_latest_game, null);
  assert.equal(timeline.matchups[0].teams[0].unknown_starters[0].id, 1);
});

test("missing player-game evidence remains unknown instead of becoming zero remaining", () => {
  const missing = report();
  missing.teams[0] = team(1, 10, [player(777, 10)]);
  const timeline = buildLeagueTimeline(missing, mapping, rows());
  assert.equal(timeline.coverage.mapped_starters, 1);
  assert.equal(timeline.matchups[0].teams[0].unknown_starters[0].id, 777);
  assert.equal(timeline.matchups[0].teams[0].completed_points_before_latest_game, null);
});

test("an unfinished or unreconciled fantasy team gets no reconstructed pregame score", () => {
  const incomplete = report();
  incomplete.teams[0].final = false;
  incomplete.teams[1].lineupReconciled = false;
  const timeline = buildLeagueTimeline(incomplete, mapping, rows());
  assert.equal(timeline.matchups[0].teams[0].completed_points_before_latest_game, null);
  assert.equal(timeline.matchups[0].teams[1].completed_points_before_latest_game, null);
});

test("erased plays and nonstarters cannot win the feature ranking", () => {
  const data = rows();
  data.push(play(late, 3, "p2", "2030-10-01T00:10:00Z", { yards_gained: "99", play_type: "no_play" }));
  data.push(play(late, 4, "p2", "2030-10-01T00:20:00Z", { yards_gained: "98", play_deleted: "1" }));
  data.push(play(late, 5, "bench", "2030-10-01T00:30:00Z", { yards_gained: "97" }));
  const timeline = buildLeagueTimeline(report(), [...mapping, { espn_id: "99", gsis_id: "bench" }], data);
  assert.equal(timeline.coverage.candidate_count, 2);
  assert.equal(timeline.selectedFeature?.candidate_id, `${early}:1`);
});

test("ambiguous player mappings are excluded and duplicate notable play IDs fail closed", () => {
  const timeline = buildLeagueTimeline(report(), [...mapping, { espn_id: "2", gsis_id: "another" }], rows());
  assert.equal(timeline.coverage.mapped_starters, 1);
  assert.equal(timeline.matchups[0].teams[1].unknown_starters[0].id, 2);
  assert.throws(() => buildLeagueTimeline(report(), mapping, [...rows(), rows()[0]]), /Duplicate notable play IDs/);
});

test("verified fantasy scores attach only to the exact automatically selected play and player", () => {
  const verified = { season: 2030, week: 4, lead: { nfl_game_id: early, play_id: "1", player_name: "Player 1", team_id: 1,
    title: "Verified lead", summary: "A verified score change.", fantasy_points: 11, before: { 1: 0, 2: 10 }, after: { 1: 11, 2: 10 } } };
  const match = buildLeagueTimeline(report(), mapping, rows(), verified);
  assert.equal(match.selectedFeature?.fantasy_points, 11);
  assert.equal(match.selectedFeature?.title, "Verified lead");
  const mismatch = buildLeagueTimeline(report(), mapping, rows(), { ...verified, lead: { ...verified.lead, play_id: "999" } });
  assert.equal(mismatch.selectedFeature?.fantasy_points, undefined);
  assert.equal(mismatch.selectedFeature?.evidence_kind, "nfl_play_only");
  const compact = compactLeagueTimeline(match, 1);
  assert.equal(compact.selected_matchup?.id, 1);
  assert.equal(compact.selected_matchup_sequence.length, 2);
  assert.deepEqual(compact.week_game_highlights.map((m) => m.nfl_game_id), [early, late]);
});
