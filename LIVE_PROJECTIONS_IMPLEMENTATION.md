# Live In-Week Projections Implementation Plan

## Status: Phase 1 Complete (espn_nfl.py module built)

## Overview
Enable real-time win probability calculations during in-progress weeks by blending actual fantasy points with time-adjusted projections based on live NFL game clock data.

---

## Phase 1: NFL Game State Module ✅ COMPLETE

**File:** `src/fantasy_nfl/espn_nfl.py`

**Completed Components:**
- `fetch_nfl_scoreboard()` - Fetches ESPN NFL API scoreboard
- `parse_nfl_game_states()` - Extracts game state by NFL team ID
- `NFLGameState` dataclass - Contains period, clock, completion %
- `calculate_game_completion()` - Converts period + clock → completion %
- `parse_clock_to_seconds()` - Parses "8:32" → 512 seconds
- `calculate_live_projection()` - Blends actual + remaining projection
- `save_nfl_game_state()` / `load_nfl_game_state()` - JSON persistence

**Key Logic:**
```python
# Game completion calculation
completion_pct = (completed_quarters × 900 + elapsed_in_current) / 3600

# Live projection calculation
if completion_pct == 0.0:
    return original_projection  # Pre-game
elif completion_pct >= 1.0:
    return actual_points  # Final
else:
    remaining_pct = 1.0 - completion_pct
    return actual_points + (original_projection × remaining_pct)
```

---

## Phase 2: Simulator Integration (IN PROGRESS)

### 2.1 Add NFL Game State Loading to Simulator

**File:** `src/fantasy_nfl/simulator.py`

**New Method:**
```python
def _load_nfl_game_state(self, season: int, week: int) -> dict[str, NFLGameState]:
    """Load cached NFL game state for a specific week."""
    game_state_path = (
        self.settings.data_root
        / "raw"
        / "nfl"
        / str(season)
        / f"game_state_week_{week}.json"
    )

    from .espn_nfl import load_nfl_game_state
    return load_nfl_game_state(game_state_path)
```

**Add to imports:**
```python
from .espn_nfl import NFLGameState, calculate_live_projection
```

---

### 2.2 Modify Player-Level Projection Loading

**Current Location:** `RestOfSeasonSimulator._load_week_projection()` (line ~1140)

**Problem:** Returns DataFrame with `projected_points` only - doesn't consider actual scores

**Solution:** Create new method `_load_week_projection_with_live_blend()`:

```python
def _load_week_projection_with_live_blend(
    self,
    season: int,
    week: int,
    nfl_game_states: dict[str, NFLGameState],
) -> pd.DataFrame:
    """
    Load week projections and blend with actual scores for in-progress weeks.

    For each player:
    1. Load original projection
    2. Load actual fantasy_points from weekly_scores CSV
    3. Look up player's NFL team game state
    4. Calculate live projection = actual + (projection × remaining_pct)
    """

    # Load base projections
    proj_df = self._load_week_projection(season, week)

    # Load actual scores
    scores_df = self._load_week_scores(season, week)

    if proj_df.empty or scores_df.empty:
        return proj_df

    # Merge projections with actuals on player ID
    merged = proj_df.merge(
        scores_df[['espn_player_id', 'fantasy_points', 'pro_team_id', 'stat_week']],
        on='espn_player_id',
        how='left',
        suffixes=('_proj', '_actual')
    )

    # Calculate live projections
    def calc_live_proj(row):
        actual_pts = row.get('fantasy_points', 0.0) or 0.0
        original_proj = row.get('projected_points', 0.0) or 0.0
        pro_team_id = str(row.get('pro_team_id', ''))
        stat_week = row.get('stat_week')

        # If player has no stats yet (stat_week is null), game hasn't started
        if pd.isna(stat_week) or stat_week != week:
            return original_proj

        # Look up NFL game state
        game_state = nfl_game_states.get(pro_team_id)

        # Use the live projection calculator
        return calculate_live_projection(actual_pts, original_proj, game_state)

    merged['projected_points'] = merged.apply(calc_live_proj, axis=1)

    return merged
```

---

### 2.3 Integrate into Main Simulation Loop

**Location:** `RestOfSeasonSimulator.simulate_rest_of_season()` around line 822

**Current Code:**
```python
for week in weeks_to_process:
    projections = self._load_week_projection(season, week)
    if projections.empty:
        continue

    team_projections = self._summarize_team_projections(teams, projections)
```

**Updated Code:**
```python
# Load NFL game states once at start of simulation
nfl_game_states_by_week = {}
for week in weeks_to_process:
    if week in completed_weeks:
        # For in-progress weeks, load live game state
        nfl_game_states_by_week[week] = self._load_nfl_game_state(season, week)

for week in weeks_to_process:
    # Use live-blended projections if game state available
    nfl_game_states = nfl_game_states_by_week.get(week, {})

    if nfl_game_states:
        # In-progress week: blend actual + remaining
        projections = self._load_week_projection_with_live_blend(
            season, week, nfl_game_states
        )
    else:
        # Future week: use pure projections
        projections = self._load_week_projection(season, week)

    if projections.empty:
        continue

    team_projections = self._summarize_team_projections(teams, projections)
```

---

## Phase 3: CLI Commands

### 3.1 Add NFL Game State Fetch Command

**File:** `src/fantasy_nfl/cli.py`

**New Command Group:**
```python
@cli.group("nfl")
def nfl():
    """NFL live game data commands."""
    pass


@nfl.command("fetch-game-state")
@click.option("--season", type=int, required=True)
@click.option("--week", type=int, required=True)
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False),
    default=".env",
    help="Path to .env file",
)
def nfl_fetch_game_state(season: int, week: int, env_file: Path) -> None:
    """Fetch live NFL game state from ESPN API."""
    from .espn_nfl import (
        fetch_nfl_scoreboard,
        parse_nfl_game_states,
        save_nfl_game_state,
    )

    settings = get_settings(env_file)

    click.echo(f"Fetching NFL game state for week {week}...")
    scoreboard = fetch_nfl_scoreboard(week=week)

    game_states = parse_nfl_game_states(scoreboard)
    click.echo(f"Found {len(game_states)} NFL team game states")

    output_path = (
        settings.data_root
        / "raw"
        / "nfl"
        / str(season)
        / f"game_state_week_{week}.json"
    )

    saved_path = save_nfl_game_state(game_states, output_path)
    click.echo(f"Saved game state → {saved_path}")

    # Print summary
    for team_id, gs in list(game_states.items())[:5]:
        click.echo(
            f"  {gs.team_abbrev}: Period {gs.period}, "
            f"{gs.clock_display}, {gs.completion_pct:.1%} complete"
        )
```

**Add to imports:**
```python
# At top of cli.py
from .espn_nfl import fetch_nfl_scoreboard, parse_nfl_game_states, save_nfl_game_state
```

---

### 3.2 Integrate into Refresh Pipeline

**Location:** `refresh_week` command in `cli.py` (around line 400)

**Add after ESPN data fetch:**
```python
# After fetching ESPN views (around line 445)
click.echo(f"[3/7] Fetching NFL game state for week {target_week}")
try:
    from .espn_nfl import fetch_nfl_scoreboard, parse_nfl_game_states, save_nfl_game_state

    scoreboard = fetch_nfl_scoreboard(week=target_week)
    game_states = parse_nfl_game_states(scoreboard)

    output_path = (
        settings.data_root
        / "raw"
        / "nfl"
        / str(target_season)
        / f"game_state_week_{target_week}.json"
    )
    save_nfl_game_state(game_states, output_path)
    click.echo(f"Saved {len(game_states)} NFL team game states")
except Exception as e:
    click.echo(f"Warning: Failed to fetch NFL game state: {e}", err=True)
    # Don't fail the whole refresh if NFL fetch fails
```

**Update step numbers:** Increment all subsequent steps by 1 (normalize becomes 4/7, etc.)

---

## Phase 4: Testing

### 4.1 Unit Tests for espn_nfl Module

**File:** `tests/test_espn_nfl.py` (NEW)

```python
import pytest
from fantasy_nfl.espn_nfl import (
    parse_clock_to_seconds,
    calculate_game_completion,
    calculate_live_projection,
    NFLGameState,
)


def test_parse_clock_to_seconds():
    assert parse_clock_to_seconds("15:00") == 900
    assert parse_clock_to_seconds("8:32") == 512
    assert parse_clock_to_seconds("0:00") == 0
    assert parse_clock_to_seconds("invalid") == 0


def test_calculate_game_completion():
    # Pre-game
    assert calculate_game_completion(0, 0) == 0.0

    # Start of Q1
    assert calculate_game_completion(1, 900) == 0.0

    # End of Q2 (halftime)
    assert calculate_game_completion(2, 0) == 0.5

    # Mid Q4
    assert calculate_game_completion(4, 450) == pytest.approx(0.875)

    # Overtime
    assert calculate_game_completion(5, 0) == 1.0


def test_calculate_live_projection():
    # Pre-game
    game_state = NFLGameState(
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
    assert calculate_live_projection(0.0, 20.0, game_state) == 20.0

    # Mid-game (50% complete, player at projected pace)
    game_state.period = 2
    game_state.clock_seconds = 0
    game_state.completion_pct = 0.5
    assert calculate_live_projection(10.0, 20.0, game_state) == 20.0

    # Mid-game (player outperforming)
    assert calculate_live_projection(15.0, 20.0, game_state) == 25.0

    # Late game (85.7% complete, player exceeding projection)
    game_state.period = 4
    game_state.clock_seconds = 512  # 8:32 left
    game_state.completion_pct = 0.857
    result = calculate_live_projection(30.0, 20.0, game_state)
    assert result == pytest.approx(32.86, abs=0.01)

    # Final
    game_state.completion_pct = 1.0
    assert calculate_live_projection(18.0, 20.0, game_state) == 18.0
```

---

### 4.2 Integration Test with Week 4 Data

**Test Script:**
```bash
# Fetch current NFL game state
poetry run fantasy nfl fetch-game-state --season 2025 --week 4

# Rebuild simulation with live projections
poetry run fantasy sim rest-of-season --season 2025 --simulations 500

# Check win probabilities are no longer all 50%
curl -s "http://localhost:40435/api/sim/rest-of-season?season=2025" | \
  jq '.weeks[] | select(.week == 4) | .matchups[] | select(.home_team_id == 4) | {home_win_prob: .home_win_probability, away_win_prob: .away_win_probability}'
```

**Expected:** Win probabilities should reflect live scores, not 50/50

---

## Phase 5: Frontend Integration (Future)

**Goal:** Display live win probabilities in UI

**Changes Needed:**
- Add win probability to WeekCell component
- Show live vs projected breakdown
- Update every refresh (minute-by-minute during games)

**Example UI:**
```
Week 4: vs Small Eyes Big Head
Your Score: 117.4 (projected) → 95.3 (actual + 22.1 remaining)
Opponent: 110.8 (projected) → 88.4 (actual + 18.6 remaining)
Win Probability: 68% ↑ (was 55% pre-game)
```

---

## Dependencies

### Required Python Packages
- `httpx` - Already installed for HTTP requests
- No new dependencies needed!

---

## Data Flow

```
ESPN NFL API
    ↓ fetch_nfl_scoreboard(week=4)
NFL Game State JSON
    ↓ parse_nfl_game_states()
{team_id → NFLGameState}
    ↓ save to data/raw/nfl/2025/game_state_week_4.json
    ↓
Simulator loads during rest-of-season
    ↓ _load_week_projection_with_live_blend()
    ↓ merges: projections + actual scores + NFL game states
    ↓ calculate_live_projection() per player
Live Team Projections
    ↓ _estimate_win_probabilities()
Accurate Win Probabilities
    ↓ JSON output
Frontend Display
```

---

## Error Handling

### Graceful Degradation
If NFL game state fetch fails:
1. Log warning but continue refresh
2. Fall back to pure projections (current behavior)
3. Don't block simulation generation

### Edge Cases
- **Player on bye:** No game state → use projection
- **Player injured mid-game:** Use actual points + 0 remaining
- **Overtime:** Set completion_pct = 1.0
- **Game delayed:** May show pre-game state longer than expected

---

## Performance Considerations

- **ESPN NFL API:** ~100KB response, <500ms latency
- **Game state cache:** Reuse within same refresh cycle
- **No simulation slowdown:** O(1) lookup per player via dict

---

## Next Steps

1. **Implement Phase 2:** Simulator integration (~150 lines)
2. **Implement Phase 3:** CLI commands (~80 lines)
3. **Test with live data:** Run during Monday night game
4. **Commit:** Single feature commit with all components
5. **Monitor:** Watch win probabilities update during games

---

## Success Criteria

✅ Week 4 win probabilities reflect live scores (not 50/50)
✅ Jonathan Taylor scenario works: 30 actual + 5 remaining = 35 live projection
✅ Pre-game weeks still use pure projections
✅ Completed weeks use actual scores only
✅ Refresh pipeline automatically fetches NFL game state
✅ No regressions in existing simulator behavior

---

**Estimated Time to Complete:** 2-3 hours
**Risk Level:** Medium (integration with core simulator logic)
**Reversibility:** High (isolated module, can disable via config)