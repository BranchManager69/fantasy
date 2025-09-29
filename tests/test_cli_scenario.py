import json
from pathlib import Path

import pytest
import pandas as pd
from click.testing import CliRunner

from fantasy_nfl.cli import cli
from fantasy_nfl.scoring import ScoreEngine, ScoringConfig
from fantasy_nfl.settings import AppSettings


@pytest.fixture()
def data_root(tmp_path: Path) -> Path:
    root = tmp_path / "data"

    # Baseline weekly scores for week 1
    espn_out = root / "out" / "espn" / "2025"
    espn_out.mkdir(parents=True, exist_ok=True)
    (espn_out / "weekly_scores_2025_week_1.csv").write_text(
        """season,team_id,player_name,lineup_slot,espn_position,score_total,counts_for_score
2025,1,Player One,QB,QB,12.5,TRUE
2025,2,Player Two,QB,QB,18.0,TRUE
""",
        encoding="utf-8",
    )

    (root / "raw" / "espn" / "2025").mkdir(parents=True, exist_ok=True)
    (root / "raw" / "espn" / "2025" / "view-mMatchup.json").write_text(
        json.dumps(
            {
                "schedule": [
                    {
                        "matchupPeriodId": 1,
                        "id": 1001,
                        "home": {"teamId": 1, "totalPoints": 120},
                        "away": {"teamId": 2, "totalPoints": 110},
                        "winner": "HOME",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    projections_dir = root / "out" / "projections" / "2025"
    projections_dir.mkdir(parents=True, exist_ok=True)
    (projections_dir / "projected_stats_week_5.csv").write_text(
        """season,team_id,player_name,lineup_slot,espn_position,projected_points,counts_for_score
2025,1,Projected One,QB,QB,21.5,TRUE
2025,2,Projected Two,QB,QB,19.0,FALSE
""",
        encoding="utf-8",
    )

    return root


def test_scenario_create_and_describe(data_root: Path) -> None:
    runner = CliRunner()
    env = {"DATA_ROOT": str(data_root)}

    scoring_settings = AppSettings(
        espn_email=None,
        espn_password=None,
        espn_s2=None,
        espn_swid=None,
        espn_league_id=None,
        espn_season=2025,
        data_root=data_root,
        log_level="INFO",
    )
    scoring_config = ScoringConfig.load(Path("config/scoring.yaml"))
    engine = ScoreEngine(scoring_settings, scoring_config)

    result = runner.invoke(
        cli,
        [
            "scenario",
            "create",
            "--season",
            "2025",
            "--id",
            "demo",
            "--label",
            "Demo Scenario",
            "--copy-completed",
            "1",
            "--copy-projection",
            "5",
        ],
        env=env,
    )
    assert result.exit_code == 0, result.output

    overlay_path = data_root / "overlays" / "2025" / "demo.json"
    assert overlay_path.exists()
    overlay = json.loads(overlay_path.read_text())

    assert overlay["scenario_id"] == "demo"
    assert overlay["label"] == "Demo Scenario"
    assert "1" in overlay.get("completed_weeks", {})
    week1 = overlay["completed_weeks"]["1"]
    team_entries = week1["teams"]["1"]["entries"]
    assert team_entries[0]["player_name"] == "Player One"
    matchup = week1["matchups"]["1001"]
    assert matchup["home_points"] == 120.0

    assert "5" in overlay.get("projection_weeks", {})
    proj_entry = overlay["projection_weeks"]["5"]["teams"]["1"]["entries"][0]
    assert proj_entry["projected_points"] == 21.5

    # Second create without overwrite should fail
    result_conflict = runner.invoke(
        cli,
        [
            "scenario",
            "create",
            "--season",
            "2025",
            "--id",
            "demo",
            "--copy-completed",
            "1",
        ],
        env=env,
    )
    assert result_conflict.exit_code != 0
    assert "Overlay already exists" in result_conflict.output

    # Describe output should reference the scenario
    describe = runner.invoke(
        cli,
        ["scenario", "describe", "--season", "2025", "--id", "demo"],
        env=env,
    )
    assert describe.exit_code == 0
    assert "Scenario: demo" in describe.output
    assert "Week 1" in describe.output

    # Update player score first
    result_player_score = runner.invoke(
        cli,
        [
            "scenario",
            "set-player-score",
            "--season",
            "2025",
            "--id",
            "demo",
            "--week",
            "1",
            "--team",
            "1",
            "--player-name",
            "Player One",
            "--lineup-slot",
            "QB",
            "--position",
            "QB",
            "--stat",
            "receptions=10",
            "--stat",
            "receiving_yards=100",
        ],
        env=env,
    )
    assert result_player_score.exit_code == 0, result_player_score.output

    result_player_projection = runner.invoke(
        cli,
        [
            "scenario",
            "set-player-projection",
            "--season",
            "2025",
            "--id",
            "demo",
            "--week",
            "5",
            "--team",
            "1",
            "--player-name",
            "Projected One",
            "--lineup-slot",
            "QB",
            "--position",
            "QB",
            "--stat",
            "passing_yards=250",
        ],
        env=env,
    )
    assert result_player_projection.exit_code == 0, result_player_projection.output

    # Override totals via team-level commands as well
    result_score = runner.invoke(
        cli,
        [
            "scenario",
            "set-score",
            "--season",
            "2025",
            "--id",
            "demo",
            "--week",
            "1",
            "--matchup",
            "1001",
            "--home-points",
            "150",
            "--away-points",
            "90",
        ],
        env=env,
    )
    assert result_score.exit_code == 0, result_score.output

    result_projection = runner.invoke(
        cli,
        [
            "scenario",
            "set-projection",
            "--season",
            "2025",
            "--id",
            "demo",
            "--week",
            "5",
            "--team",
            "1",
            "--points",
            "40",
        ],
        env=env,
    )
    assert result_projection.exit_code == 0, result_projection.output

    overlay_after = json.loads(overlay_path.read_text())

    # Player score should reflect stat override and recomputed points
    team_entries = overlay_after["completed_weeks"]["1"]["teams"]["1"]["entries"]
    player_entry = next(entry for entry in team_entries if entry.get("player_name") == "Player One")
    assert player_entry.get("receptions") == 10.0
    assert player_entry.get("receiving_yards") == 100.0

    baseline_scores = pd.read_csv(data_root / "out" / "espn" / "2025" / "weekly_scores_2025_week_1.csv")
    baseline_row = (
        baseline_scores.loc[baseline_scores["player_name"].str.lower() == "player one".lower()] \
        .iloc[0]
        .to_dict()
    )
    baseline_row["receptions"] = 10.0
    baseline_row["receiving_yards"] = 100.0
    expected_player_points = engine.score_dataframe(pd.DataFrame([baseline_row])).iloc[0]["score_total"]
    assert player_entry["score_total"] == pytest.approx(expected_player_points)

    proj_entries = overlay_after["projection_weeks"]["5"]["teams"]["1"]["entries"]
    player_proj = next(entry for entry in proj_entries if entry.get("player_name") == "Projected One")
    assert player_proj.get("passing_yards") == 250.0

    baseline_proj = pd.read_csv(data_root / "out" / "projections" / "2025" / "projected_stats_week_5.csv")
    baseline_proj_row = (
        baseline_proj.loc[baseline_proj["player_name"].str.lower() == "projected one".lower()] \
        .iloc[0]
        .to_dict()
    )
    baseline_proj_row["passing_yards"] = 250.0
    expected_proj_points = engine.score_dataframe(pd.DataFrame([baseline_proj_row])).iloc[0]["score_total"]
    assert player_proj["projected_points"] == pytest.approx(expected_proj_points)

    matchups = overlay_after["completed_weeks"]["1"]["matchups"]
    assert matchups["1001"]["home_points"] == 150.0

    diff = runner.invoke(
        cli,
        ["scenario", "diff", "--season", "2025", "--id", "demo"],
        env=env,
    )
    assert diff.exit_code == 0, diff.output
    assert "Matchup 1001" in diff.output
    assert "Team 1" in diff.output
