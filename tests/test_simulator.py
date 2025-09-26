from pathlib import Path

import pandas as pd
import pytest

from fantasy_nfl.settings import AppSettings
from fantasy_nfl.simulator import RestOfSeasonSimulator


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    df = pd.DataFrame(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)


def sample_settings(data_root: Path, season: int = 2025) -> AppSettings:
    return AppSettings(
        espn_email=None,
        espn_password=None,
        espn_s2=None,
        espn_swid=None,
        espn_league_id=None,
        espn_season=season,
        data_root=data_root,
        log_level="INFO",
    )


def create_minimal_artifacts(base_dir: Path) -> None:
    teams_rows = [
        {
            "team_id": 1,
            "team_name": "Alpha Squad",
            "abbrev": "ALP",
            "owners": "Alice",
            "logo": "http://logo/alpha.png",
        },
        {
            "team_id": 2,
            "team_name": "Beta Crew",
            "abbrev": "BET",
            "owners": "Bob",
            "logo": "http://logo/beta.png",
        },
    ]
    schedule_rows = [
        {
            "season": 2025,
            "matchup_id": 101,
            "matchup_period_id": 1,
            "week": 1,
            "home_team_id": 1,
            "home_points": 0,
            "away_team_id": 2,
            "away_points": 0,
            "winner": "UNDECIDED",
        },
        {
            "season": 2025,
            "matchup_id": 202,
            "matchup_period_id": 2,
            "week": 2,
            "home_team_id": 2,
            "home_points": 0,
            "away_team_id": 1,
            "away_points": 0,
            "winner": "UNDECIDED",
        },
    ]

    espn_out = base_dir / "out" / "espn" / "2025"
    write_csv(espn_out / "teams.csv", teams_rows)
    write_csv(espn_out / "schedule.csv", schedule_rows)

    projections_dir = base_dir / "out" / "projections" / "2025"

    week1_rows = [
        {
            "season": 2025,
            "week": 1,
            "team_id": 1,
            "espn_player_id": 11,
            "player_name": "Alpha QB",
            "lineup_slot": "QB",
            "espn_position": "QB",
            "projected_points": 18.5,
            "counts_for_score": True,
        },
        {
            "season": 2025,
            "week": 1,
            "team_id": 1,
            "espn_player_id": 12,
            "player_name": "Alpha RB",
            "lineup_slot": "RB",
            "espn_position": "RB",
            "projected_points": 12.0,
            "counts_for_score": True,
        },
        {
            "season": 2025,
            "week": 1,
            "team_id": 2,
            "espn_player_id": 21,
            "player_name": "Beta QB",
            "lineup_slot": "QB",
            "espn_position": "QB",
            "projected_points": 19.0,
            "counts_for_score": True,
        },
        {
            "season": 2025,
            "week": 1,
            "team_id": 2,
            "espn_player_id": 22,
            "player_name": "Beta WR",
            "lineup_slot": "WR",
            "espn_position": "WR",
            "projected_points": 16.0,
            "counts_for_score": True,
        },
    ]

    week2_rows = [
        {
            "season": 2025,
            "week": 2,
            "team_id": 1,
            "espn_player_id": 13,
            "player_name": "Alpha WR",
            "lineup_slot": "WR",
            "espn_position": "WR",
            "projected_points": 17.5,
            "counts_for_score": True,
        },
        {
            "season": 2025,
            "week": 2,
            "team_id": 1,
            "espn_player_id": 14,
            "player_name": "Alpha FLEX",
            "lineup_slot": "FLEX",
            "espn_position": "RB",
            "projected_points": 11.2,
            "counts_for_score": True,
        },
        {
            "season": 2025,
            "week": 2,
            "team_id": 2,
            "espn_player_id": 23,
            "player_name": "Beta RB",
            "lineup_slot": "RB",
            "espn_position": "RB",
            "projected_points": 10.0,
            "counts_for_score": True,
        },
        {
            "season": 2025,
            "week": 2,
            "team_id": 2,
            "espn_player_id": 24,
            "player_name": "Beta FLEX",
            "lineup_slot": "FLEX",
            "espn_position": "WR",
            "projected_points": 13.3,
            "counts_for_score": True,
        },
    ]

    write_csv(projections_dir / "projected_stats_week_1.csv", week1_rows)
    write_csv(projections_dir / "projected_stats_week_2.csv", week2_rows)


def test_simulator_builds_dataset(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    create_minimal_artifacts(data_root)
    settings = sample_settings(data_root)
    simulator = RestOfSeasonSimulator(settings)

    dataset = simulator.build_dataset(season=2025, start_week=1, end_week=2)

    assert dataset["start_week"] == 1
    assert dataset["end_week"] == 2
    assert len(dataset["weeks"]) == 2

    week1 = dataset["weeks"][0]
    assert week1["week"] == 1
    matchup = week1["matchups"][0]
    assert matchup["home"]["projected_points"] == 30.5  # 18.5 + 12.0
    assert matchup["away"]["projected_points"] == 35.0  # 19.0 + 16.0
    assert matchup["home"]["starters"][0]["player_name"] == "Alpha QB"

    # Team schedule should contain entries for both teams and weeks
    team_schedule = dataset["team_schedule"]
    assert set(team_schedule.keys()) == {"1", "2"}
    assert len(team_schedule["1"]) == 2
    assert team_schedule["1"][0]["opponent_team_id"] == 2

    standings = dataset["standings"]
    assert len(standings) == 2
    alpha = next(item for item in standings if item["team"]["team_id"] == 1)
    beta = next(item for item in standings if item["team"]["team_id"] == 2)

    # Projected points totals should align with weekly aggregates
    assert alpha["projected_points"] == pytest.approx(30.5 + 28.7, rel=1e-6)
    assert beta["projected_points"] == pytest.approx(35.0 + 23.3, rel=1e-6)


def test_simulator_default_start_week_skips_completed(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    create_minimal_artifacts(data_root)

    # Mark week 1 as completed by creating weekly_scores file
    espn_out = data_root / "out" / "espn" / "2025"
    write_csv(
        espn_out / "weekly_scores_2025_week_1.csv",
        [
            {
                "team_id": 1,
                "score_total": 120,
            }
        ],
    )

    settings = sample_settings(data_root)
    simulator = RestOfSeasonSimulator(settings)

    dataset = simulator.build_dataset(season=2025)

    assert dataset["start_week"] == 2
    assert dataset["end_week"] == 2


def test_simulator_monte_carlo_summary(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    create_minimal_artifacts(data_root)
    settings = sample_settings(data_root)
    simulator = RestOfSeasonSimulator(settings)

    dataset = simulator.build_dataset(
        season=2025,
        start_week=1,
        end_week=2,
        sigma=0.0,
        sim_iterations=200,
        playoff_slots=1,
        random_seed=123,
    )

    monte_carlo = dataset.get("monte_carlo")
    assert isinstance(monte_carlo, dict)
    assert monte_carlo["iterations"] == 200
    assert monte_carlo["playoff_slots"] == 1

    team_entries = {entry["team"]["team_id"]: entry for entry in monte_carlo["teams"]}
    assert set(team_entries.keys()) == {1, 2}

    alpha = team_entries[1]
    beta = team_entries[2]

    # With sigma = 0 the outcomes are deterministic: both teams go 1-1, Alpha wins the seed tiebreaker.
    assert alpha["playoff_odds"] == pytest.approx(1.0)
    assert beta["playoff_odds"] == pytest.approx(0.0)
    assert alpha["seed_distribution"]["1"] == pytest.approx(1.0)
    assert beta["seed_distribution"]["2"] == pytest.approx(1.0)
