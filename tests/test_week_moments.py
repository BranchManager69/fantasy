import pytest

from fantasy_nfl.week_moments import (
    EvidenceError,
    MAPPING,
    build_week_one_moments,
    checked_weights,
    historical_roster,
    reconstruct_game,
    skill_player_delta,
)


@pytest.fixture
def weights():
    return {"rushing_yards": .1, "rushing_tds": 6, "rushing_long_td": 1,
            "receiving_yards": .1, "receiving_tds": 6, "receiving_long_td": 1,
            "receptions": 1, "fumbles_lost": -2, "passing_int": -2}


def rushing_play(play_id, yards, touchdown=0, **changes):
    return {"game_id": "test", "play_id": str(play_id), "play_type": "run",
            "rusher_player_id": "walker", "rushing_yards": str(yards),
            "rush_touchdown": str(touchdown), "qtr": "3", "time": "12:53",
            "desc": "A recorded play", **changes}


def test_long_touchdown_includes_yards_td_and_league_bonus(weights):
    assert skill_player_delta(rushing_play(1, 60, 1), "walker", weights) == 13
    assert skill_player_delta(rushing_play(2, 60), "walker", weights) == 6
    assert skill_player_delta(rushing_play(3, 49, 1), "walker", weights) == 10.9


def test_erased_touchdown_cannot_flip_the_score(weights):
    erased = rushing_play(1, 60, 1, play_type="no_play")
    assert skill_player_delta(erased, "walker", weights) == 0
    assert skill_player_delta(rushing_play(2, 60, 1, play_deleted="1"), "walker", weights) == 0


def test_score_order_uses_numeric_play_id_even_if_input_is_reversed(weights):
    rows = [rushing_play(10, 60, 1), rushing_play(2, 10)]
    timeline, totals = reconstruct_game(rows, {"walker": "Walker"}, weights, 10, 20)
    assert [p["play_id"] for p in timeline] == ["2", "10"]
    assert timeline[0]["realzy_after"] == 11
    assert (timeline[1]["realzy_before"], timeline[1]["realzy_after"]) == (11, 24)
    assert totals == {"walker": 14}


def test_duplicate_plays_are_rejected_instead_of_double_counted(weights):
    play = rushing_play(1, 60, 1)
    with pytest.raises(EvidenceError, match="Duplicate"):
        reconstruct_game([play, play], {"walker": "Walker"}, weights, 10, 20)


def test_overtime_touchdown_gets_ppr_but_targeted_interception_does_not_penalize_receiver(weights):
    play = {"play_type": "pass", "receiver_player_id": "receiver", "receiving_yards": "4",
            "complete_pass": "1", "pass_touchdown": "1", "qtr": "5"}
    assert skill_player_delta(play, "receiver", weights) == 7.4
    intercepted = {"play_type": "pass", "receiver_player_id": "receiver", "interception": "1"}
    assert skill_player_delta(intercepted, "receiver", weights) == 0


def test_scoring_config_drift_stops_evidence_generation(weights):
    snapshot = {"settings": {"scoringSettings": {"scoringItems": [
        {"statId": stat, "points": weights[name]} for name, stat in MAPPING.items()]}}}
    config = {"weights": {**weights, "rushing_long_td": 0}}
    with pytest.raises(EvidenceError, match="rushing_long_td"):
        checked_weights(snapshot, config)


def test_current_roster_cannot_substitute_for_historical_scoring_period():
    with pytest.raises(EvidenceError, match="scoring period"):
        historical_roster({"seasonId": 2026, "scoringPeriodId": 2}, 2026, 1)


def test_unresearched_week_does_not_reuse_week_one_story(tmp_path):
    with pytest.raises(EvidenceError, match="Only the researched"):
        build_week_one_moments(tmp_path, tmp_path / "not-read.yaml", 2026, 2)
