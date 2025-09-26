from pathlib import Path

import pandas as pd
import pytest

from fantasy_nfl.projections import ProjectionManager
from fantasy_nfl.scoring import ScoringConfig
from fantasy_nfl.settings import AppSettings


def _write_scoring_config(path: Path) -> None:
    path.write_text(
        """
include_positions:
  - QB
  - WR
weights:
  passing_yards: 0.04
  passing_tds: 4
  passing_int: -2
  receiving_yards: 0.1
  receptions: 1
  receiving_tds: 6
"""
    )


def test_projection_manager_build(tmp_path: Path) -> None:
    baseline = pd.DataFrame(
        [
            {
                "season": 2025,
                "week": 3,
                "espn_player_id": 1,
                "player_name": "Quarterback Uno",
                "team_id": 8,
                "espn_position": "QB",
                "lineup_slot": "QB",
                "passing_yards": 300,
                "passing_tds": 2,
                "passing_int": 1,
            },
            {
                "season": 2025,
                "week": 3,
                "espn_player_id": 2,
                "player_name": "Wideout Dos",
                "team_id": 7,
                "espn_position": "WR",
                "lineup_slot": "WR",
                "receiving_yards": 80,
                "receiving_tds": 1,
                "receptions": 6,
            },
        ]
    )
    baseline_path = tmp_path / "baseline.csv"
    baseline.to_csv(baseline_path, index=False)

    manual = pd.DataFrame(
        [
            {
                "season": 2025,
                "week": 3,
                "espn_player_id": 1,
                "passing_yards": 320,
            }
        ]
    )
    manual_path = tmp_path / "manual.csv"
    manual.to_csv(manual_path, index=False)

    assumptions_path = tmp_path / "assumptions.yaml"
    assumptions_path.write_text(
        """
stat_multipliers:
  global:
    passing_yards: 1.1
stat_additions:
  positions:
    WR:
      receiving_yards: 10
"""
    )

    scoring_cfg_path = tmp_path / "scoring.yaml"
    _write_scoring_config(scoring_cfg_path)
    scoring_config = ScoringConfig.load(scoring_cfg_path)

    settings = AppSettings(
        espn_email=None,
        espn_password=None,
        espn_s2=None,
        espn_swid=None,
        espn_league_id="123",
        espn_season=2025,
        data_root=tmp_path,
        log_level="INFO",
    )

    manager = ProjectionManager(settings, scoring_config)
    output_path = tmp_path / "projected.csv"
    result = manager.build_week_projection(
        season=2025,
        week=3,
        baseline_path=baseline_path,
        manual_override_path=manual_path,
        assumptions_path=assumptions_path,
        output_path=output_path,
    )

    assert output_path.exists()
    assert len(result) == 2

    qb = result.loc[result["espn_player_id"] == 1].iloc[0]
    wr = result.loc[result["espn_player_id"] == 2].iloc[0]

    assert qb["passing_yards"] == 320  # manual override applied after multipliers
    assert wr["receiving_yards"] == 90  # 80 + 10 from positional addition

    assert qb["projected_points"] == pytest.approx(18.8)
    assert wr["projected_points"] == pytest.approx(21.0)
