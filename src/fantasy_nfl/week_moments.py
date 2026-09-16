"""Reproduce the verified 2026 Week 1 story from cached evidence, without a model.

This deliberately supports one researched matchup. It is not a general scoring
engine or an estimate of the scoreboard ESPN displayed live. Reconciliation is
mandatory before any narrative is emitted.
"""
from __future__ import annotations

import csv
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


BENCH_SLOTS = {20, 21, 25, 26, 27}
MAPPING = {
    "rushing_yards": 24, "rushing_tds": 25, "rushing_long_td": 36,
    "receptions": 53, "receiving_yards": 42, "receiving_tds": 43,
    "receiving_long_td": 46, "fumbles_lost": 72, "passing_int": 20,
}
MONDAY_GAME = "2026_01_DEN_KC"
WALKER, WADDLE, ST_BROWN, LOVE = "4567048", "4372016", "4374302", "4036378"
EVIDENCE_COLUMNS = (
    "game_id", "play_id", "game_date", "time_of_day", "qtr", "time", "desc",
    "play_type", "play_deleted", "season", "week", "season_type",
    "passer_player_id", "receiver_player_id", "rusher_player_id",
    "fumbled_1_player_id", "fumbled_2_player_id", "passing_yards", "rushing_yards",
    "receiving_yards", "complete_pass", "pass_touchdown", "rush_touchdown",
    "interception", "fumble_lost", "two_point_attempt",
)


class EvidenceError(ValueError):
    """The cached evidence cannot substantiate the supported story."""


def number(value: Any) -> float:
    return float(value or 0)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise EvidenceError(message)


def checked_weights(snapshot: dict, config: dict) -> dict[str, float]:
    """Reject drift between the local offensive scoring config and ESPN."""
    items = {item["statId"]: item for item in snapshot["settings"]["scoringSettings"]["scoringItems"]}
    weights = config["weights"]
    for name, stat_id in MAPPING.items():
        require(name in weights and stat_id in items, f"Missing scoring rule: {name}")
        require(abs(number(weights[name]) - number(items[stat_id]["points"])) < 1e-8,
                f"Scoring config disagrees with ESPN for {name}")
    return {name: number(weights[name]) for name in MAPPING}


def skill_player_delta(play: dict, player_id: str, weights: dict[str, float]) -> float:
    """Score supported RB/WR events, excluding erased plays and special teams.

    ESPN's stat 36/46 bonuses count 50+ yard touchdowns. The supported Monday
    game has one such event, a 60-yard rushing TD. Player-level final totals and
    ESPN's bonus count are separately reconciled by the builder.
    """
    if number(play.get("play_deleted")) or play.get("play_type") not in {"run", "pass"}:
        return 0.0
    involved = player_id in {play.get(k) for k in (
        "rusher_player_id", "receiver_player_id", "fumbled_1_player_id", "fumbled_2_player_id")}
    if not involved:
        return 0.0
    require(not number(play.get("two_point_attempt")), "Two-point plays require separate scoring support")
    require(not (play.get("fumbled_2_player_id") and number(play.get("fumble_lost"))),
            "Multiple-fumble attribution is unsupported")
    value = 0.0
    if play.get("rusher_player_id") == player_id:
        yards, td = number(play.get("rushing_yards")), number(play.get("rush_touchdown"))
        value += yards * weights["rushing_yards"] + td * weights["rushing_tds"]
        if td and yards >= 50:
            value += weights["rushing_long_td"]
    if play.get("receiver_player_id") == player_id:
        yards, td = number(play.get("receiving_yards")), number(play.get("pass_touchdown"))
        value += yards * weights["receiving_yards"] + td * weights["receiving_tds"]
        value += number(play.get("complete_pass")) * weights["receptions"]
        if td and yards >= 50:
            value += weights["receiving_long_td"]
    if play.get("fumbled_1_player_id") == player_id:
        value += number(play.get("fumble_lost")) * weights["fumbles_lost"]
    return round(value, 8)


def reconstruct_game(rows: list[dict], players: dict[str, str], weights: dict[str, float],
                     starting_score: float, opponent_score: float) -> tuple[list[dict], dict[str, float]]:
    """Reconstruct one game's score in numeric play order, never CSV row order."""
    require(len({r["game_id"] for r in rows}) == 1, "Reconstruction requires exactly one NFL game")
    require(len({r["play_id"] for r in rows}) == len(rows), "Duplicate play IDs in cached game")
    running = {player_id: 0.0 for player_id in players}
    timeline = []
    for play in sorted(rows, key=lambda r: number(r["play_id"])):
        before = round(starting_score + sum(running.values()), 8)
        changes = []
        for player_id, name in players.items():
            delta = skill_player_delta(play, player_id, weights)
            if delta:
                running[player_id] = round(running[player_id] + delta, 8)
                changes.append({"player": name, "points": delta})
        if changes:
            timeline.append({"game_id": play["game_id"], "play_id": play["play_id"],
                             "quarter": int(number(play["qtr"])), "clock": play["time"],
                             "description": play["desc"], "player_changes": changes,
                             "realzy_before": before,
                             "realzy_after": round(starting_score + sum(running.values()), 8),
                             "mr_beastsaw": opponent_score})
    return timeline, running


def historical_roster(snapshot: dict, season: int, week: int) -> tuple[dict, dict, list[dict]]:
    require(snapshot.get("seasonId") == season and snapshot.get("scoringPeriodId") == week,
            "Historical snapshot must match the requested season and scoring period")
    require(snapshot.get("settings", {}).get("scheduleSettings", {}).get("matchupPeriodLength", 1) == 1,
            "Only one-week matchup periods are supported")
    matches = [m for m in snapshot["schedule"] if m["id"] == 3 and m["matchupPeriodId"] == week]
    require(len(matches) == 1, "Expected historical matchup 3")
    matchup = matches[0]
    require(matchup.get("winner") == "HOME", "Supported matchup must have a final home win")
    require(matchup["home"]["teamId"] == 3 and matchup["away"]["teamId"] == 8,
            "Unexpected teams in the supported matchup")
    names = {t["id"]: t["name"] for t in snapshot["teams"]}
    players, reconciliation = {}, []
    for side_name in ("home", "away"):
        side = matchup[side_name]
        roster = side.get("rosterForCurrentScoringPeriod", {})
        starters = []
        for entry in roster.get("entries", []):
            if entry.get("lineupSlotId") in BENCH_SLOTS:
                continue
            require(entry.get("lineupSlotId") is not None, "Historical lineup slot is missing")
            player = entry["playerPoolEntry"]["player"]
            actuals = [s for s in player.get("stats", []) if s.get("seasonId") == season
                       and s.get("scoringPeriodId") == week and s.get("statSourceId") == 0
                       and s.get("statSplitTypeId", 1) == 1]
            require(len(actuals) == 1, f"Missing or ambiguous actual stats for {player.get('fullName')}")
            player_id = str(player["id"])
            require(player_id not in players, "A starter appears more than once")
            players[player_id] = {"espn_id": player_id, "player_name": player["fullName"],
                                  "team_id": side["teamId"], "lineup_slot_id": entry["lineupSlotId"],
                                  "actual": actuals[0], "nfl_games": {}}
            starters.append({"espn_id": int(player_id), "name": player["fullName"],
                             "lineup_slot_id": entry["lineupSlotId"], "points": actuals[0]["appliedTotal"]})
        total = round(sum(p["points"] for p in starters), 8)
        require(bool(starters) and abs(total - side["totalPoints"]) < 1e-8
                and abs(total - number(roster.get("appliedStatTotal"))) < 1e-8,
                f"Historical starters do not reconcile for team {side['teamId']}")
        reconciliation.append({"team_id": side["teamId"], "name": names[side["teamId"]],
                               "starter_count": len(starters), "starters": starters,
                               "computed_total": total, "espn_total": side["totalPoints"], "matches": True})
    return matchup, players, reconciliation


def build_week_one_moments(data_root: Path, scoring_path: Path, season: int, week: int) -> dict:
    require((season, week) == (2026, 1), "Only the researched 2026 Week 1 matchup is supported")
    snapshot_path = data_root / "raw" / "espn" / str(season) / f"view-mMatchupScore-week-{week}.json"
    pbp_path = data_root / "raw" / "nflverse" / f"play_by_play_{season}.csv"
    mapping_path = data_root / "raw" / "nflverse" / "players.csv"
    snapshot = json.loads(snapshot_path.read_text())
    matchup, players, reconciliation = historical_roster(snapshot, season, week)
    weights = checked_weights(snapshot, yaml.safe_load(scoring_path.read_text()))
    with pbp_path.open(newline="") as handle:
        all_rows = list(csv.DictReader(handle))
    rows = [r for r in all_rows if number(r["season"]) == season and number(r["week"]) == week
            and r["season_type"] == "REG"]
    require(bool(rows), "No regular-season play-by-play for the requested week")
    gsis = {}
    with mapping_path.open(newline="") as handle:
        for mapped in csv.DictReader(handle):
            espn_id = mapped["espn_id"].removesuffix(".0")
            if espn_id in players:
                require("gsis_id" not in players[espn_id], f"Ambiguous player mapping for {espn_id}")
                players[espn_id]["gsis_id"] = mapped["gsis_id"]
                gsis[mapped["gsis_id"]] = players[espn_id]
    require(all("gsis_id" in p for p in players.values()), "Missing starter ID mapping")
    for row in rows:
        for role in ("passer_player_id", "receiver_player_id", "rusher_player_id"):
            if row[role] in gsis:
                gsis[row[role]]["nfl_games"][row["game_id"]] = row["game_date"]
    require(all(p["nfl_games"] for p in players.values()), "Starter NFL game dates are incomplete")
    for player_id, team_id in ((WALKER, 3), (WADDLE, 3), (ST_BROWN, 8), (LOVE, 8)):
        require(player_id in players and players[player_id]["team_id"] == team_id,
                "The historical starting lineup differs from the researched matchup")
    walker, waddle, st_brown, love = (players[p] for p in (WALKER, WADDLE, ST_BROWN, LOVE))
    monday_rows = [r for r in rows if r["game_id"] == MONDAY_GAME]
    require(bool(monday_rows), "Monday play-by-play is missing")
    monday_date = monday_rows[0]["game_date"]
    for player_id, player in players.items():
        if player_id in (WALKER, WADDLE):
            require(set(player["nfl_games"]) == {MONDAY_GAME}, "Unexpected Monday player games")
        else:
            require(all(d < monday_date for d in player["nfl_games"].values()),
                    "Another starter was still playing on Monday; the reconstruction is unsupported")
    starting_score = round(matchup["home"]["totalPoints"] - walker["actual"]["appliedTotal"]
                           - waddle["actual"]["appliedTotal"], 8)
    opponent_score = number(matchup["away"]["totalPoints"])
    monday_players = {p["gsis_id"]: p["player_name"] for p in (walker, waddle)}
    timeline, running = reconstruct_game(monday_rows, monday_players, weights, starting_score, opponent_score)
    for player in (walker, waddle):
        require(abs(running[player["gsis_id"]] - player["actual"]["appliedTotal"]) < 1e-8,
                f"Reconstructed points disagree with ESPN for {player['player_name']}")
    require(walker["actual"]["stats"].get("25") == 1 and walker["actual"]["stats"].get("36") == 1,
            "Walker rushing touchdown and bonus counts changed")
    require(abs(walker["actual"]["appliedStats"].get("36", 0) - weights["rushing_long_td"]) < 1e-8,
            "Walker long-touchdown bonus does not reconcile")
    by_play = {(r["game_id"], r["play_id"]): r for r in rows}
    require(len(by_play) == len(rows), "Duplicate cached play identifiers")
    def play(game: str, play_id: str) -> dict:
        require((game, play_id) in by_play, f"Missing evidence play {game}/{play_id}")
        row = by_play[(game, play_id)]
        require(not number(row.get("play_deleted")) and row.get("play_type") in {"run", "pass"},
                "A selected evidence play was erased")
        return row
    td = play(MONDAY_GAME, "2252")
    overtime = play("2026_01_NO_DET", "5097")
    fumble, interception = play("2026_01_GB_MIN", "3754"), play("2026_01_GB_MIN", "3877")
    require(td["rusher_player_id"] == walker["gsis_id"] and number(td["rushing_yards"]) == 60
            and number(td["rush_touchdown"]) == 1, "Lead-play details changed")
    require(overtime["receiver_player_id"] == st_brown["gsis_id"] and number(overtime["qtr"]) == 5
            and number(overtime["receiving_yards"]) == 4 and number(overtime["pass_touchdown"]) == 1,
            "Overtime touchdown details changed")
    require(fumble["fumbled_1_player_id"] == love["gsis_id"] and number(fumble["fumble_lost"]) == 1
            and interception["passer_player_id"] == love["gsis_id"] and number(interception["interception"]) == 1,
            "Turnover attribution changed")
    require(fumble["qtr"] == interception["qtr"] == "4" and fumble["time"] == "05:01"
            and interception["time"] == "04:21", "Turnover sequence clock changed")
    for stat_id, weight in (("72", "fumbles_lost"), ("20", "passing_int")):
        require(love["actual"]["stats"].get(stat_id) == 1
                and abs(love["actual"]["appliedStats"].get(stat_id, 0) - weights[weight]) < 1e-8,
                "Love turnover points do not reconcile")
    st_brown_total = sum(skill_player_delta(r, st_brown["gsis_id"], weights)
                         for r in rows if r["game_id"] == "2026_01_NO_DET")
    require(abs(st_brown_total - st_brown["actual"]["appliedTotal"]) < 1e-8,
            "St. Brown play-by-play points do not reconcile")
    flip_index = next((i for i, event in enumerate(timeline) if event["play_id"] == "2252"), None)
    require(flip_index is not None, "Lead-changing play has no scoring event")
    flip = timeline[flip_index]
    require(flip["realzy_before"] < opponent_score < flip["realzy_after"]
            and all(t["realzy_after"] < opponent_score for t in timeline[:flip_index])
            and all(t["realzy_after"] > opponent_score for t in timeline[flip_index:]),
            "The selected play no longer proves the described lead change")
    pbp_url = f"https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{season}.csv.gz"
    def moment(moment_id: str, player: dict, evidence: list[dict], description: str,
               points: float, note: str, components: list[tuple[int, float]]) -> dict:
        first = evidence[0]
        return {"id": moment_id, "player_name": player["player_name"], "team_id": player["team_id"],
                "nfl_game_id": first["game_id"], "quarter": int(number(first["qtr"])), "clock": first["time"],
                "play_id": first["play_id"], "time_of_day": first["time_of_day"], "description": description,
                "fantasy_points": round(points, 8), "source_url": pbp_url, "note": note,
                "scoring_components": [{"stat_id": stat, "points": round(value, 8)} for stat, value in components],
                "evidence": [{k: row.get(k, "") for k in EVIDENCE_COLUMNS} for row in evidence]}
    td_points = skill_player_delta(td, walker["gsis_id"], weights)
    before, after = flip["realzy_before"], flip["realzy_after"]
    moments = [moment(
        "walker-60-yard-lead-change", walker, [td],
        f"Walker took a handoff 60 yards for a touchdown on Monday night. That one run moved Realzy "
        f"from {before:.1f}–{opponent_score:.1f} behind to {after:.1f}–{opponent_score:.1f} ahead.",
        td_points, "Scores are reconstructed from corrected play-by-play, not a captured live ESPN feed.",
        [(24, 60 * weights["rushing_yards"]), (25, weights["rushing_tds"]), (36, weights["rushing_long_td"])]),
        moment("st-brown-overtime-touchdown", st_brown, [overtime],
               "Overtime gave Mr. Beastsaw another scoring chance: St. Brown caught a four-yard touchdown "
               "from Jared Goff with 5:07 left in the extra period.",
               skill_player_delta(overtime, st_brown["gsis_id"], weights),
               "The actual play is verified; a different result without overtime would be speculation.",
               [(53, weights["receptions"]), (42, 4 * weights["receiving_yards"]), (43, weights["receiving_tds"])]),
        moment("love-two-turnovers", love, [fumble, interception],
               "Two giveaways in 40 seconds of game clock: Love lost a fumble at 5:01, then threw an "
               "interception at 4:21.", weights["fumbles_lost"] + weights["passing_int"],
               "A two-play sequence. Both deductions are confirmed in ESPN's applied Week 1 stats.",
               [(72, weights["fumbles_lost"]), (20, weights["passing_int"])])]
    moments[0].update(reconstructed_score_before={"3": before, "8": opponent_score},
                      reconstructed_score_after={"3": after, "8": opponent_score})
    moments[2].update(clock="05:01–04:21", scope="two-play sequence", related_play_ids=["3877"])
    source_specs = [("Historical ESPN Week 1 matchup and scoring rules", snapshot_path,
                     f"https://fantasy.espn.com/football/league/scoreboard?leagueId={snapshot['id']}&seasonId={season}&matchupPeriodId={week}"),
                    ("nflverse play-by-play", pbp_path, pbp_url),
                    ("nflverse player ID mapping", mapping_path, "https://github.com/nflverse/nflverse-data/releases/tag/players"),
                    ("Local scoring config, checked against ESPN", scoring_path, None)]
    sources = [{"name": name, "path": str(path.resolve()), "url": url,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for name, path, url in source_specs]
    return {
        "season": season, "week": week, "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_url": pbp_url, "matchup_id": 3,
        "teams": [{"id": r["team_id"], "name": r["name"]} for r in reconciliation],
        "lead": {"title": "The 60-yard run that flipped the matchup",
                 "summary": f"Mr. Beastsaw led by {opponent_score - before:g} points when Kenneth Walker III "
                 f"took a handoff 60 yards to the end zone on Monday night. The run was worth {td_points:g} "
                 f"fantasy points and put Realzy Revenge Tour ahead, {after:.1f}–{opponent_score:.1f}.",
                 "player_name": walker["player_name"], "team_id": 3, "nfl_game_id": MONDAY_GAME,
                 "quarter": int(number(td["qtr"])), "clock": td["time"], "play_id": td["play_id"],
                 "fantasy_points": td_points, "before": {"3": before, "8": opponent_score},
                 "after": {"3": after, "8": opponent_score}, "source_url": pbp_url,
                 "source_refs": {"moment_id": moments[0]["id"], "historical_roster": str(snapshot_path), "pbp": str(pbp_path)},
                 "method_note": "Retrospective reconstruction from corrected play-by-play and verified historical lineups. "
                 "Both Monday players reconcile exactly to ESPN final points."},
        "moments": moments, "reconciliation": reconciliation, "sources": sources,
        "evidence_counts": {"pbp_rows": len(all_rows), "pbp_week1_rows": len(rows),
                            "pbp_week1_games": len({r["game_id"] for r in rows}),
                            "historical_starters": len(players), "monday_scoring_events_reconstructed": len(timeline), "moments": 3},
        "roster_selection": {"snapshot_season": season, "snapshot_scoring_period": week,
                             "path": "schedule[id=3].home/away.rosterForCurrentScoringPeriod.entries",
                             "excluded_slot_ids": sorted(BENCH_SLOTS),
                             "stat_filter": {"seasonId": season, "scoringPeriodId": week, "statSourceId": 0}},
        "monday_reconstruction": {
            "description": "All Mr. Beastsaw starters finished before Monday. Realzy had Walker and Waddle left. "
            "Scores use final corrected play stats, not an archived live scoring feed.",
            "sunday_score": {"3": starting_score, "8": opponent_score},
            "final_score": {"3": matchup["home"]["totalPoints"], "8": opponent_score},
            "remaining_players": [{"espn_id": int(p["espn_id"]), "name": p["player_name"],
                                   "nfl_games": p["nfl_games"], "espn_points": p["actual"]["appliedTotal"],
                                   "reconstructed_points": running[p["gsis_id"]]} for p in (walker, waddle)],
            "opponent_game_dates": [{k: p[k] for k in ("espn_id", "player_name", "nfl_games")}
                                    for p in players.values() if p["team_id"] == 8], "timeline": timeline},
    }


def write_week_one_moments(data_root: Path, scoring_path: Path, season: int, week: int) -> Path:
    """Validate everything before replacing an existing evidence artifact."""
    result = build_week_one_moments(data_root, scoring_path, season, week)
    output = data_root / "out" / "league" / str(season) / f"week_{week}_moments.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(output)
    return output
