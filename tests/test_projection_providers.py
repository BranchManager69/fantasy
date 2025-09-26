from pathlib import Path

import json
import pandas as pd

from fantasy_nfl.projection_providers import build_projection_baseline
from fantasy_nfl.settings import AppSettings


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def test_build_projection_baseline_espn_primary(tmp_path: Path) -> None:
    season = 2025
    week = 3

    raw_dir = tmp_path / "raw" / "espn" / str(season)
    out_dir = tmp_path / "out" / "espn" / str(season)

    roster_csv = out_dir / "roster.csv"
    roster_df = pd.DataFrame(
        [
            {"team_id": 1, "espn_player_id": 100, "player_name": "QB One", "lineup_slot": "QB", "position": "QB"},
            {"team_id": 1, "espn_player_id": 200, "player_name": "RB Two", "lineup_slot": "RB", "position": "RB"},
        ]
    )
    roster_csv.parent.mkdir(parents=True, exist_ok=True)
    roster_df.to_csv(roster_csv, index=False)

    weekly_stats = pd.DataFrame(
        [
            {
                "season": season,
                "scoring_period_id": 2,
                "team_id": 1,
                "espn_player_id": 200,
                "player_name": "RB Two",
                "lineup_slot": "RB",
                "espn_position": "RB",
                "rushing_yards": 60,
                "rushing_tds": 1,
            }
        ]
    )
    weekly_stats.to_csv(out_dir / f"weekly_stats_{season}_week_2.csv", index=False)

    mroster_data = {
        "teams": [
            {
                "id": 1,
                "roster": {
                    "entries": [
                        {
                            "lineupSlotId": 0,
                            "playerPoolEntry": {
                                "player": {
                                    "id": 100,
                                    "fullName": "QB One",
                                    "defaultPositionId": 0,
                                    "stats": [
                                        {
                                            "scoringPeriodId": week,
                                            "statSourceId": 1,
                                            "statSplitTypeId": 1,
                                            "stats": {
                                                "3": 250,
                                                "4": 2,
                                                "20": 1,
                                            },
                                        }
                                    ],
                                }
                            },
                        }
                    ]
                },
            }
        ]
    }
    _write(raw_dir / f"view-mRoster-week-{week}.json", json.dumps(mroster_data))

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

    df = build_projection_baseline(settings, season, week, ["espn", "usage"], lookback_weeks=1)
    assert set(df["espn_player_id"]) == {100, 200}

    qb = df.loc[df["espn_player_id"] == 100].iloc[0]
    assert qb["passing_yards"] == 250
    assert qb["passing_tds"] == 2
    assert qb["passing_int"] == 1

    rb = df.loc[df["espn_player_id"] == 200].iloc[0]
    assert rb["rushing_yards"] == 60
    assert rb["rushing_tds"] == 1
