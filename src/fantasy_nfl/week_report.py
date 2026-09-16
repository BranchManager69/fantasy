"""Small, auditable weekly views built from ESPN's historical scoring-period snapshot."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .normalize import LINEUP_SLOT_NAMES, POSITION_NAMES


def build_week_report(snapshot: dict[str, Any], week: int) -> dict[str, Any]:
    season = int(snapshot["seasonId"])
    if int(snapshot.get("scoringPeriodId", -1)) != week:
        raise ValueError("Historical roster snapshot must match the requested scoring period")
    settings = snapshot.get("settings", {})
    if settings.get("scheduleSettings", {}).get("matchupPeriodLength", 1) != 1:
        raise ValueError("Weekly reports currently require one-week matchup periods")
    teams = {t["id"]: t for t in snapshot.get("teams", [])}
    results: list[dict[str, Any]] = []
    matchups: list[dict[str, Any]] = []
    for matchup in snapshot.get("schedule", []):
        if matchup.get("matchupPeriodId") != week:
            continue
        home, away = matchup.get("home", {}), matchup.get("away", {})
        if home.get("teamId") not in teams or away.get("teamId") not in teams:
            continue
        final = matchup.get("winner") in {"HOME", "AWAY", "TIE"}
        matchups.append({"id": matchup["id"], "homeId": home["teamId"], "awayId": away["teamId"], "final": final})
        for side, opponent, side_name in [(home, away, "HOME"), (away, home, "AWAY")]:
            roster = side.get("rosterForCurrentScoringPeriod", {}).get("entries", [])
            players = []
            for entry in roster:
                pool = entry.get("playerPoolEntry", {})
                player = pool.get("player", {})
                slot = entry.get("lineupSlotId")
                points = pool.get("appliedStatTotal")
                players.append({
                    "id": player.get("id", entry.get("playerId")),
                    "name": player.get("fullName", "Unknown player"),
                    "position": POSITION_NAMES.get(player.get("defaultPositionId"), ""),
                    "slot": LINEUP_SLOT_NAMES.get(slot, str(slot)),
                    "slotId": slot,
                    "eligibleSlots": player.get("eligibleSlots", []),
                    "starter": slot is not None and slot not in {20, 21, 25, 26, 27},
                    "points": round(float(points), 2) if points is not None else None,
                })
            score, opponent_score = round(float(side.get("totalPoints", 0)), 2), round(float(opponent.get("totalPoints", 0)), 2)
            starter_total = round(sum(p["points"] or 0 for p in players if p["starter"]), 2)
            winner = matchup.get("winner")
            result = "pending" if not final else "tie" if winner == "TIE" else "win" if winner == side_name else "loss"
            results.append({
                "id": side["teamId"], "name": teams[side["teamId"]].get("name", str(side["teamId"])),
                "opponentId": opponent["teamId"], "opponentName": teams[opponent["teamId"]].get("name", str(opponent["teamId"])),
                "matchupId": matchup["id"], "score": score, "opponentScore": opponent_score,
                "result": result, "final": final, "players": players,
                "lineupReconciled": bool(players) and all(p["points"] is not None for p in players if p["starter"]) and abs(starter_total - score) < 0.015,
                "starterTotal": starter_total,
            })
    if len({r["id"] for r in results}) != len(results):
        raise ValueError("Multiple matchups for one team in a week require a different report format")
    complete = bool(results) and all(r["final"] for r in results) and len(results) == len(teams)
    for row in results:
        others = [r for r in results if r["id"] != row["id"]]
        row["allPlay"] = {
            "wins": sum(row["score"] > other["score"] for other in others),
            "losses": sum(row["score"] < other["score"] for other in others),
            "ties": sum(row["score"] == other["score"] for other in others),
        } if complete else None
    return {
        "season": season, "week": week, "leagueName": settings.get("name", "Our league"),
        "generatedAt": datetime.now(timezone.utc).isoformat(), "complete": complete,
        "currentWeek": snapshot.get("status", {}).get("currentMatchupPeriod"),
        "sourceUrl": f"https://fantasy.espn.com/football/league/scoreboard?leagueId={snapshot['id']}&seasonId={season}&matchupPeriodId={week}",
        "teams": sorted(results, key=lambda r: (-r["score"], r["id"])), "matchups": matchups,
    }
