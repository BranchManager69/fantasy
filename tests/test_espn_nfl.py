import pytest

from fantasy_nfl.espn_nfl import (
    NFLGameState,
    calculate_game_completion,
    calculate_live_projection,
    parse_clock_to_seconds,
)


def test_parse_clock_to_seconds():
    assert parse_clock_to_seconds("15:00") == 900
    assert parse_clock_to_seconds("8:32") == 512
    assert parse_clock_to_seconds("0:00") == 0
    assert parse_clock_to_seconds("invalid") == 0


def test_calculate_game_completion():
    assert calculate_game_completion(0, 0) == 0.0
    assert calculate_game_completion(1, 900) == 0.0
    assert calculate_game_completion(2, 0) == 0.5
    # Q4, 8:32 remaining = 512 seconds → elapsed current = 388 → (3*900 + 388)/3600
    value = calculate_game_completion(4, 512)
    assert value == pytest.approx((2700 + 388) / 3600, abs=1e-6)
    assert calculate_game_completion(5, 0) == 1.0


def test_calculate_live_projection():
    # Pre-game: use original projection
    gs = NFLGameState(
        nfl_team_id="11",
        team_abbrev="IND",
        opponent_abbrev="TEN",
        period=0,
        clock_display="0:00",
        clock_seconds=0,
        state="pre",
        completed=False,
        completion_pct=0.0,
    )
    assert calculate_live_projection(0.0, 20.0, gs) == 20.0

    # Mid-game at 50%
    gs.period = 2
    gs.clock_seconds = 0
    gs.completion_pct = 0.5
    assert calculate_live_projection(10.0, 20.0, gs) == 20.0
    assert calculate_live_projection(15.0, 20.0, gs) == 25.0

    # Late game (approx 85.7%)
    gs.period = 4
    gs.clock_seconds = 512
    gs.completion_pct = (2700 + (900 - 512)) / 3600
    result = calculate_live_projection(30.0, 20.0, gs)
    assert result == pytest.approx(30.0 + 20.0 * (1 - gs.completion_pct), abs=0.01)

    # Final
    gs.completion_pct = 1.0
    assert calculate_live_projection(18.0, 20.0, gs) == 18.0


