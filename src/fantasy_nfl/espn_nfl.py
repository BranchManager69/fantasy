"""
ESPN NFL API integration for live game state and clock data.

This module fetches real-time NFL game information from ESPN's public NFL API,
providing game clock, quarter, and completion percentage data needed for
in-week live fantasy projections.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx


ESPN_NFL_SCOREBOARD_URL = "http://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
GAME_DURATION_SECONDS = 60 * 60  # 60 minutes (4 quarters × 15 min)
QUARTER_DURATION_SECONDS = 15 * 60


@dataclass
class NFLGameState:
    """Live state of an NFL game."""

    nfl_team_id: str  # ESPN NFL team ID (e.g., "11" for Colts)
    team_abbrev: str  # Team abbreviation (e.g., "IND")
    opponent_abbrev: str
    period: int  # 0=pre-game, 1-4=quarters, 5+=overtime
    clock_display: str  # Time display (e.g., "8:32")
    clock_seconds: int  # Seconds remaining in current period
    state: str  # "pre", "in", "post"
    completed: bool
    completion_pct: float  # 0.0 to 1.0


def parse_clock_to_seconds(clock_display: str) -> int:
    """
    Parse ESPN clock display to seconds.

    Examples:
        "8:32" -> 512 seconds
        "0:00" -> 0 seconds
        "15:00" -> 900 seconds
    """
    try:
        parts = clock_display.split(":")
        if len(parts) == 2:
            minutes = int(parts[0])
            seconds = int(parts[1])
            return minutes * 60 + seconds
        return 0
    except (ValueError, AttributeError):
        return 0


def calculate_game_completion(period: int, clock_seconds: int) -> float:
    """
    Calculate game completion percentage based on period and clock.

    Args:
        period: Quarter (0=pre, 1-4=regulation, 5+=OT)
        clock_seconds: Seconds remaining in current period

    Returns:
        Completion percentage from 0.0 (pre-game) to 1.0 (final)

    Examples:
        Period 1, 15:00 left -> 0.0 (game just started)
        Period 2, 7:30 left -> 0.3125 (31.25% complete)
        Period 4, 0:00 left -> 1.0 (game over)
    """
    if period == 0:
        # Pre-game
        return 0.0
    elif period >= 5:
        # Overtime or completed
        return 1.0
    else:
        # Regular time: calculate elapsed time
        completed_quarters = period - 1
        elapsed_in_current = QUARTER_DURATION_SECONDS - clock_seconds
        total_elapsed = (completed_quarters * QUARTER_DURATION_SECONDS) + elapsed_in_current
        return min(1.0, total_elapsed / GAME_DURATION_SECONDS)


def fetch_nfl_scoreboard(week: Optional[int] = None, timeout: int = 10) -> dict:
    """
    Fetch live NFL scoreboard data from ESPN API.

    Args:
        week: Optional NFL week number (defaults to current week)
        timeout: Request timeout in seconds

    Returns:
        Raw ESPN scoreboard JSON
    """
    params = {}
    if week is not None:
        params["week"] = week

    response = httpx.get(ESPN_NFL_SCOREBOARD_URL, params=params, timeout=timeout)
    response.raise_for_status()
    return response.json()


def parse_nfl_game_states(scoreboard_data: dict) -> dict[str, NFLGameState]:
    """
    Parse ESPN scoreboard JSON into game state lookup by NFL team ID.

    Args:
        scoreboard_data: Raw ESPN scoreboard JSON

    Returns:
        Dict mapping NFL team ID -> NFLGameState
    """
    game_states: dict[str, NFLGameState] = {}

    events = scoreboard_data.get("events", [])
    for event in events:
        competitions = event.get("competitions", [])
        if not competitions:
            continue

        comp = competitions[0]
        status = comp.get("status", {})
        status_type = status.get("type", {})

        period = status.get("period", 0)
        clock_display = status.get("displayClock", "0:00")
        clock_seconds = parse_clock_to_seconds(clock_display)
        state = status_type.get("state", "pre")
        completed = status_type.get("completed", False)
        completion_pct = calculate_game_completion(period, clock_seconds)

        # Process both home and away teams
        for competitor in comp.get("competitors", []):
            team = competitor.get("team", {})
            team_id = team.get("id")
            team_abbrev = team.get("abbreviation", "")

            # Find opponent
            other_teams = [
                c.get("team", {}).get("abbreviation", "")
                for c in comp.get("competitors", [])
                if c.get("team", {}).get("id") != team_id
            ]
            opponent_abbrev = other_teams[0] if other_teams else ""

            if team_id:
                game_states[str(team_id)] = NFLGameState(
                    nfl_team_id=str(team_id),
                    team_abbrev=team_abbrev,
                    opponent_abbrev=opponent_abbrev,
                    period=period,
                    clock_display=clock_display,
                    clock_seconds=clock_seconds,
                    state=state,
                    completed=completed,
                    completion_pct=completion_pct,
                )

    return game_states


def save_nfl_game_state(
    game_states: dict[str, NFLGameState],
    output_path: Path,
) -> Path:
    """
    Save NFL game state to JSON file.

    Args:
        game_states: Dict of NFL team ID -> NFLGameState
        output_path: Path to save JSON file

    Returns:
        Path to saved file
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    data = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "game_states": {
            team_id: {
                "nfl_team_id": gs.nfl_team_id,
                "team_abbrev": gs.team_abbrev,
                "opponent_abbrev": gs.opponent_abbrev,
                "period": gs.period,
                "clock_display": gs.clock_display,
                "clock_seconds": gs.clock_seconds,
                "state": gs.state,
                "completed": gs.completed,
                "completion_pct": gs.completion_pct,
            }
            for team_id, gs in game_states.items()
        },
    }

    output_path.write_text(json.dumps(data, indent=2))
    return output_path


def load_nfl_game_state(input_path: Path) -> dict[str, NFLGameState]:
    """
    Load NFL game state from JSON file.

    Args:
        input_path: Path to JSON file

    Returns:
        Dict of NFL team ID -> NFLGameState
    """
    if not input_path.exists():
        return {}

    data = json.loads(input_path.read_text())
    game_states_data = data.get("game_states", {})

    return {
        team_id: NFLGameState(
            nfl_team_id=gs["nfl_team_id"],
            team_abbrev=gs["team_abbrev"],
            opponent_abbrev=gs["opponent_abbrev"],
            period=gs["period"],
            clock_display=gs["clock_display"],
            clock_seconds=gs["clock_seconds"],
            state=gs["state"],
            completed=gs["completed"],
            completion_pct=gs["completion_pct"],
        )
        for team_id, gs in game_states_data.items()
    }


def calculate_live_projection(
    actual_points: float,
    original_projection: float,
    game_state: Optional[NFLGameState],
) -> float:
    """
    Calculate live fantasy projection by blending actual performance with remaining game projection.

    Logic:
    - Pre-game (completion_pct = 0.0): Use full original projection
    - In-progress: Use actual + (original_projection × remaining_pct)
    - Final (completion_pct = 1.0): Use actual points only

    Args:
        actual_points: Fantasy points scored so far
        original_projection: Pre-game projected points for full game
        game_state: Live NFL game state (None if game state unavailable)

    Returns:
        Live projection combining actual and remaining expected points

    Examples:
        Pre-game: actual=0, projection=20, completion=0.0 -> 20.0
        Mid-game: actual=15, projection=20, completion=0.5 -> 15 + (20×0.5) = 25.0
        Final: actual=18, projection=20, completion=1.0 -> 18.0
        Outperforming: actual=30, projection=20, completion=0.857 -> 30 + (20×0.143) = 32.86
    """
    # If no game state, fall back to max of actual or projection
    if game_state is None:
        return max(actual_points, original_projection)

    completion_pct = game_state.completion_pct

    # Pre-game: use full projection
    if completion_pct == 0.0:
        return original_projection

    # Game over: use actual only
    if completion_pct >= 1.0:
        return actual_points

    # In-progress: actual + remaining projection
    remaining_pct = 1.0 - completion_pct
    remaining_projection = original_projection * remaining_pct
    return actual_points + remaining_projection
