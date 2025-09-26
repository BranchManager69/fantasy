from pathlib import Path

import pandas as pd

from fantasy_nfl.projection_baseline import ProjectionBaselineBuilder
from fantasy_nfl.settings import AppSettings


def _write_weekly(out_dir: Path, season: int, week: int, rows: list[dict]) -> None:
    df = pd.DataFrame(rows)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"weekly_stats_{season}_week_{week}.csv"
    df.to_csv(path, index=False)


def test_projection_baseline_builder(tmp_path: Path) -> None:
    season = 2025
    espn_out = tmp_path / "out" / "espn" / str(season)

    roster = pd.DataFrame(
        [
            {"team_id": 1, "espn_player_id": 100, "player_name": "QB One", "lineup_slot": "QB", "position": "QB"},
            {"team_id": 1, "espn_player_id": 200, "player_name": "RB Two", "lineup_slot": "RB", "position": "RB"},
            {"team_id": 1, "espn_player_id": 300, "player_name": "WR Three", "lineup_slot": "WR", "position": "WR"},
        ]
    )
    roster_path = espn_out / "roster.csv"
    roster_path.parent.mkdir(parents=True, exist_ok=True)
    roster.to_csv(roster_path, index=False)

    week1_rows = [
        {
            "season": season,
            "team_id": 1,
            "espn_player_id": 100,
            "player_name": "QB One",
            "lineup_slot": "QB",
            "espn_position": "QB",
            "stat_week": 1,
            "passing_yards": 300,
            "passing_tds": 2,
        },
        {
            "season": season,
            "team_id": 1,
            "espn_player_id": 200,
            "player_name": "RB Two",
            "lineup_slot": "RB",
            "espn_position": "RB",
            "stat_week": 1,
            "rushing_yards": 80,
            "rushing_tds": 1,
        },
    ]

    week2_rows = [
        {
            "season": season,
            "team_id": 1,
            "espn_player_id": 100,
            "player_name": "QB One",
            "lineup_slot": "QB",
            "espn_position": "QB",
            "stat_week": 2,
            "passing_yards": 320,
            "passing_tds": 3,
        },
        {
            "season": season,
            "team_id": 1,
            "espn_player_id": 200,
            "player_name": "RB Two",
            "lineup_slot": "RB",
            "espn_position": "RB",
            "stat_week": 2,
            "rushing_yards": 60,
            "rushing_tds": 0,
        },
    ]

    _write_weekly(espn_out, season, 1, week1_rows)
    _write_weekly(espn_out, season, 2, week2_rows)

    settings = AppSettings(
        espn_email=None,
        espn_password=None,
        espn_s2=None,
        espn_swid=None,
        espn_league_id="123",
        espn_season=season,
        data_root=tmp_path,
        log_level="INFO",
    )

    builder = ProjectionBaselineBuilder(settings, lookback_weeks=2)
    output_path = tmp_path / "in" / "projections" / str(season) / "baseline_week_3.csv"
    baseline = builder.build_week(season, 3, output_path)

    assert output_path.exists()
    assert {100, 200, 300} == set(baseline["espn_player_id"])

    qb_row = baseline.loc[baseline["espn_player_id"] == 100].iloc[0]
    rb_row = baseline.loc[baseline["espn_player_id"] == 200].iloc[0]
    wr_row = baseline.loc[baseline["espn_player_id"] == 300].iloc[0]

    assert qb_row["passing_yards"] == 310  # average of 300 and 320
    assert qb_row["passing_tds"] == 2.5
    assert rb_row["rushing_yards"] == 70  # average of 80 and 60
    assert rb_row["rushing_tds"] == 0.5
    assert wr_row.get("receiving_yards", 0) == 0

    outputs = builder.build_range(season, 1, 1)
    baseline_week1 = pd.read_csv(outputs[1])
    assert len(baseline_week1) == 3
    # No history before week 1, so values should be zeroed
    assert baseline_week1.filter(regex="yards").fillna(0).sum().sum() == 0
