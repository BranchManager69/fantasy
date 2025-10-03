from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional

import httpx

ESPN_NFL_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
GAME_DURATION_SECONDS = 60 * 60
QUARTER_DURATION_SECONDS = 15 * 60


@dataclass
class NFLGameState:
    nfl_team_id: str
    team_abbrev: str
    opponent_abbrev: str
    period: int
    clock_display: str
    clock_seconds: int
    state: str  # pre, in_progress, final
    completed: bool
    completion_pct: float


def parse_clock_to_seconds(clock_display: str) -> int:
    try:
        parts = clock_display.split(":")
        if len(parts) != 2:
            return 0
        return int(parts[0]) * 60 + int(parts[1])
    except Exception:
        return 0


def calculate_game_completion(period: int, clock_seconds: int) -> float:
    if period == 0:
        return 0.0
    if period >= 5:
        return 1.0
    completed_quarters = period - 1
    elapsed_in_current = max(0, QUARTER_DURATION_SECONDS - clock_seconds)
    total_elapsed = completed_quarters * QUARTER_DURATION_SECONDS + elapsed_in_current
    return min(1.0, total_elapsed / GAME_DURATION_SECONDS)


def calculate_live_projection(actual_points: float, original_projection: float, game_state: Optional[NFLGameState]) -> float:
    if game_state is None:
        return max(actual_points, original_projection)
    c = game_state.completion_pct
    if c <= 0.0:
        return original_projection
    if c >= 1.0:
        return actual_points
    return actual_points + original_projection * (1.0 - c)


def fetch_nfl_scoreboard(week: int) -> dict:
    with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
        resp = client.get(ESPN_NFL_SCOREBOARD_URL, params={"week": week})
        resp.raise_for_status()
        return resp.json()


def parse_nfl_game_states(scoreboard_data: dict) -> Dict[str, NFLGameState]:
    results: Dict[str, NFLGameState] = {}
    events = scoreboard_data.get("events") or []
    for event in events:
        competitions = event.get("competitions") or []
        if not competitions:
            continue
        comp = competitions[0]
        status = comp.get("status") or {}
        stype = status.get("type") or {}

        # Period/clock/state
        period = int(stype.get("period", status.get("period", 0)) or 0)
        clock_display = stype.get("displayClock") or status.get("displayClock") or "0:00"
        clock_seconds = parse_clock_to_seconds(str(clock_display))
        name = str(stype.get("name") or stype or "").upper()
        if "FINAL" in name:
            state = "final"
        elif "IN" in name or "LIVE" in name or "PROGRESS" in name:
            state = "in_progress"
        else:
            state = "pre"
        completed = state == "final"
        completion_pct = calculate_game_completion(period, clock_seconds)

        competitors = comp.get("competitors") or []
        if not competitors:
            continue

        # Build entries for both sides
        for me in competitors:
            team = me.get("team") or {}
            my_id = str(team.get("id") or "")
            if not my_id:
                continue
            my_abbrev = str(team.get("abbreviation") or team.get("shortDisplayName") or "")
            opp_abbrev = ""
            for other in competitors:
                if other is me:
                    continue
                ot = other.get("team") or {}
                opp_abbrev = str(ot.get("abbreviation") or ot.get("shortDisplayName") or "")
                break
            results[my_id] = NFLGameState(
                nfl_team_id=my_id,
                team_abbrev=my_abbrev,
                opponent_abbrev=opp_abbrev,
                period=period,
                clock_display=str(clock_display),
                clock_seconds=clock_seconds,
                state=state,
                completed=completed,
                completion_pct=completion_pct,
            )
    return results


def save_nfl_game_state(game_states: Dict[str, NFLGameState], output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "game_states": {
            tid: {
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
            for tid, gs in game_states.items()
        },
    }
    output_path.write_text(json.dumps(payload, indent=2))
    return output_path


def load_nfl_game_state(path: Path) -> Dict[str, NFLGameState]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text())
    except json.JSONDecodeError:
        return {}

    # Support both wrapped ("game_states": {...}) and flat mapping
    mapping = raw.get("game_states") if isinstance(raw, dict) else None
    if mapping is None and isinstance(raw, dict):
        mapping = raw
    if not isinstance(mapping, dict):
        return {}

    results: Dict[str, NFLGameState] = {}
    for team_id, payload in mapping.items():
        try:
            tid = str(payload.get("nfl_team_id") or team_id)
            results[tid] = NFLGameState(
                nfl_team_id=tid,
                team_abbrev=str(payload.get("team_abbrev", "")),
                opponent_abbrev=str(payload.get("opponent_abbrev", "")),
                period=int(payload.get("period", 0)),
                clock_display=str(payload.get("clock_display", "0:00")),
                clock_seconds=int(payload.get("clock_seconds", 0)),
                state=str(payload.get("state", "pre")),
                completed=bool(payload.get("completed", False)),
                completion_pct=float(payload.get("completion_pct", 0.0)),
            )
        except Exception:
            continue
    return results
