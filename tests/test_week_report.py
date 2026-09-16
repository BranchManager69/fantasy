import pytest

from fantasy_nfl.week_report import build_week_report


def sample_snapshot():
    return {"id": 123, "seasonId": 2026, "scoringPeriodId": 1,
            "settings": {"name": "Test league"}, "teams": [{"id": 1, "name": "A"}, {"id": 2, "name": "B"}],
            "schedule": [{"id": 1, "matchupPeriodId": 1, "winner": "HOME",
                          "home": {"teamId": 1, "totalPoints": 12}, "away": {"teamId": 2, "totalPoints": 10}}]}


def test_incomplete_week_has_no_all_play_claims():
    data = sample_snapshot()
    data["schedule"][0]["winner"] = "UNDECIDED"
    result = build_week_report(data, 1)
    assert result["complete"] is False
    assert all(t["allPlay"] is None and t["result"] == "pending" for t in result["teams"])


def test_ties_and_matchup_winner_are_separate():
    data = sample_snapshot()
    data["schedule"][0]["away"]["totalPoints"] = 12
    result = build_week_report(data, 1)
    assert result["teams"][0]["allPlay"] == {"wins": 0, "losses": 0, "ties": 1}
    assert result["teams"][0]["result"] == "win"  # ESPN's tiebreaker remains authoritative.


def test_current_roster_cannot_be_used_as_historical_lineup():
    with pytest.raises(ValueError, match="scoring period"):
        build_week_report(sample_snapshot(), 2)


def test_historical_lineup_reconciles_using_scoring_period_roster():
    data = sample_snapshot()
    home = data["schedule"][0]["home"]
    def entry(player_id, points, slot):
        return {"lineupSlotId": slot, "playerPoolEntry": {"appliedStatTotal": points,
                "player": {"id": player_id, "fullName": "Player", "defaultPositionId": 2}}}
    home["rosterForCurrentScoringPeriod"] = {"entries": [entry(10, 12, 2), entry(11, 25, 20)]}
    home["rosterForMatchupPeriod"] = {"entries": [entry(99, 99, 0)]}
    team = build_week_report(data, 1)["teams"][0]
    assert team["lineupReconciled"] is True
    assert team["starterTotal"] == 12
    assert [p["id"] for p in team["players"]] == [10, 11]
