import json
from pathlib import Path

import pandas as pd
import pytest

from fantasy_nfl.settings import AppSettings
from fantasy_nfl.simulator import RestOfSeasonSimulator, default_simulation_output


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
    write_csv(espn_out / "league_settings.csv", [{
        "playoff_team_count": 1,
        "regular_season_matchups": 2,
    }])

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

    # A score file alone is not final; the league's matchup winner settles it.
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
    schedule_path = espn_out / "schedule.csv"
    schedule = pd.read_csv(schedule_path)
    schedule.loc[schedule["week"] == 1, ["winner", "home_points", "away_points"]] = ["HOME", 120, 100]
    schedule.to_csv(schedule_path, index=False)

    settings = sample_settings(data_root)
    simulator = RestOfSeasonSimulator(settings)

    dataset = simulator.build_dataset(season=2025)

    assert dataset["start_week"] == 2
    assert dataset["end_week"] == 2


def test_live_score_file_does_not_remove_week_from_standings_or_simulation(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    create_minimal_artifacts(data_root)
    espn_out = data_root / "out" / "espn" / "2025"
    write_csv(espn_out / "weekly_scores_2025_week_1.csv", [
        {"team_id": 1, "espn_player_id": 11, "score_total": 7, "counts_for_score": True},
        {"team_id": 2, "espn_player_id": 21, "score_total": 3, "counts_for_score": True},
    ])
    simulator = RestOfSeasonSimulator(sample_settings(data_root))
    dataset = simulator.build_dataset(season=2025, sim_iterations=100, random_seed=7)

    assert dataset["start_week"] == 1
    assert dataset["completed_weeks"] == []
    for standing in dataset["standings"]:
        record = standing["projected_record"]
        assert record["wins"] + record["losses"] == pytest.approx(2.0)
        assert standing["games_remaining"] == 2
    for entry in dataset["monte_carlo"]["teams"]:
        assert entry["average_wins"] + entry["average_losses"] == pytest.approx(2.0)


def test_explicit_range_keeps_final_results_without_player_score_artifacts(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    create_minimal_artifacts(data_root)
    schedule_path = data_root / "out" / "espn" / "2025" / "schedule.csv"
    schedule = pd.read_csv(schedule_path)
    schedule.loc[schedule["week"] == 1, ["winner", "home_points", "away_points"]] = ["HOME", 120, 100]
    schedule.to_csv(schedule_path, index=False)
    simulator = RestOfSeasonSimulator(sample_settings(data_root))
    dataset = simulator.build_dataset(
        season=2025, start_week=1, end_week=2, sigma=0, sim_iterations=10, random_seed=7,
    )

    assert dataset["completed_weeks"] == [1]
    week1 = dataset["weeks"][0]["matchups"][0]
    assert week1["is_actual"] is True
    assert week1["final_score"] == {"home": 120, "away": 100}
    alpha = next(entry for entry in dataset["monte_carlo"]["teams"] if entry["team"]["team_id"] == 1)
    assert alpha["average_wins"] == 2
    assert alpha["average_losses"] == 0

    completed_only = simulator.build_dataset(
        season=2025, start_week=1, end_week=1, sim_iterations=10, random_seed=7,
    )
    assert completed_only["start_week"] == completed_only["end_week"] == 1
    assert completed_only["sources"]["projections_weeks"] == []
    assert all(entry["games_remaining"] == 0 for entry in completed_only["standings"])


def test_fresh_season_horizon_comes_from_league_settings(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    settings = sample_settings(data_root, season=2026)
    write_csv(data_root / "out" / "espn" / "2026" / "league_settings.csv", [{
        "playoff_team_count": 6, "regular_season_matchups": 14, "size": 14,
    }])
    simulator = RestOfSeasonSimulator(settings)

    assert simulator._detect_projection_weeks(2026) == []
    assert simulator.regular_season_end_week(2026) == 14


@pytest.mark.parametrize("week_args, expected_end", [
    ([], 14),
    (["--week", "2"], 2),
    (["--start-week", "2", "--end-week", "4"], 4),
])
def test_fresh_2026_refresh_builds_requested_horizon(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, week_args: list[str], expected_end: int,
) -> None:
    from click.testing import CliRunner
    import fantasy_nfl.cli as cli_module

    data_root = tmp_path / "data"
    settings = sample_settings(data_root, season=2026)
    write_csv(data_root / "out" / "espn" / "2026" / "league_settings.csv", [{
        "playoff_team_count": 6, "regular_season_matchups": 14, "size": 14,
    }])
    monkeypatch.setattr(cli_module, "get_settings", lambda _: settings)
    monkeypatch.setattr(cli_module.refresh_week, "callback", lambda **_: 2)
    calls: dict[str, list[dict]] = {}

    def record(name: str):
        def callback(**kwargs):
            calls.setdefault(name, []).append(kwargs)
        return callback

    for name in ("projections_baseline", "projections_apply", "calc_trade_chart", "calc_redraft_rankings", "sim_rest_of_season"):
        monkeypatch.setattr(getattr(cli_module, name), "callback", record(name))

    result = CliRunner().invoke(cli_module.cli, ["refresh-all", "--season", "2026", *week_args])

    assert result.exit_code == 0, result.output
    baseline = calls["projections_baseline"][0]
    assert (baseline["season"], baseline["start_week"], baseline["end_week"]) == (2026, 2, expected_end)
    assert [call["week"] for call in calls["projections_apply"]] == list(range(2, expected_end + 1))
    assert calls["sim_rest_of_season"][0]["end_week"] == expected_end


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


def test_simulator_applies_overlays(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    create_minimal_artifacts(data_root)

    espn_out = data_root / "out" / "espn" / "2025"
    write_csv(
        espn_out / "weekly_scores_2025_week_1.csv",
        [
            {
                "team_id": 1,
                "player_name": "Baseline QB",
                "lineup_slot": "QB",
                "espn_position": "QB",
                "score_total": 120,
                "counts_for_score": True,
            },
            {
                "team_id": 2,
                "player_name": "Baseline QB",
                "lineup_slot": "QB",
                "espn_position": "QB",
                "score_total": 115,
                "counts_for_score": True,
            },
        ],
    )

    raw_dir = data_root / "raw" / "espn" / "2025"
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_payload = {
        "schedule": [
            {
                "matchupPeriodId": 1,
                "id": 101,
                "home": {"teamId": 1, "totalPoints": 120},
                "away": {"teamId": 2, "totalPoints": 115},
                "winner": "AWAY",
            },
            {
                "matchupPeriodId": 2,
                "id": 202,
                "home": {"teamId": 2, "totalPoints": 0},
                "away": {"teamId": 1, "totalPoints": 0},
                "winner": "UNDECIDED",
            },
        ]
    }
    (raw_dir / "view-mMatchup.json").write_text(json.dumps(raw_payload, indent=2))

    overlay_dir = data_root / "overlays" / "2025"
    overlay_dir.mkdir(parents=True, exist_ok=True)
    overlay_payload = {
        "scenario_id": "what-if",
        "label": "What If",
        "season": 2025,
        "completed_weeks": {
            "1": {
                "teams": {
                    "1": {
                        "entries": [
                            {
                                "player_name": "Overlay QB",
                                "lineup_slot": "QB",
                                "espn_position": "QB",
                                "score_total": 150,
                                "counts_for_score": True,
                            }
                        ]
                    },
                    "2": {
                        "entries": [
                            {
                                "player_name": "Overlay Opp QB",
                                "lineup_slot": "QB",
                                "espn_position": "QB",
                                "score_total": 90,
                                "counts_for_score": True,
                            }
                        ]
                    },
                },
                "matchups": {
                    "101": {
                        "home_team_id": 1,
                        "away_team_id": 2,
                        "home_points": 150,
                        "away_points": 90,
                        "winner": "HOME",
                    }
                },
            }
        },
        "projection_weeks": {
            "2": {
                "teams": {
                    "1": {
                        "entries": [
                            {
                                "player_name": "Overlay Week2 QB",
                                "lineup_slot": "QB",
                                "espn_position": "QB",
                                "projected_points": 99,
                                "counts_for_score": True,
                            }
                        ]
                    }
                }
            }
        },
    }
    (overlay_dir / "what-if.json").write_text(json.dumps(overlay_payload, indent=2))

    settings = sample_settings(data_root)
    simulator = RestOfSeasonSimulator(settings)
    dataset = simulator.build_dataset(season=2025, start_week=2, end_week=2, scenario_id="what-if")

    scenario_meta = dataset.get("scenario")
    assert isinstance(scenario_meta, dict)
    assert scenario_meta["id"] == "what-if"
    assert scenario_meta["overrides"]["completed_weeks"] == [1]
    assert scenario_meta["overrides"]["projection_weeks"] == [2]

    assert dataset.get("completed_weeks") == [1]

    team1_schedule = dataset["team_schedule"]["1"]
    actual_flags = [(entry["week"], entry.get("is_actual")) for entry in team1_schedule]
    assert (1, True) in actual_flags, actual_flags
    week1_entry = next(
        entry for entry in team1_schedule if entry["week"] == 1 and entry.get("is_actual")
    )
    assert week1_entry["actual_points"] == 150.0
    assert week1_entry["result"] == "win"

    week2_entry = next(
        entry for entry in team1_schedule if entry["week"] == 2 and not entry.get("is_actual", False)
    )
    assert week2_entry["projected_points"] == 99.0

    team1_standing = next(item for item in dataset["standings"] if item["team"]["team_id"] == 1)
    assert team1_standing["projected_points"] == pytest.approx(249.0, rel=1e-6)


def test_default_simulation_output_handles_scenarios(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    settings = sample_settings(data_root)

    baseline = default_simulation_output(settings, 2025)
    assert baseline.name == "rest_of_season.json"

    custom = default_simulation_output(settings, 2025, "what-if")
    assert custom.name == "rest_of_season__scenario-what-if.json"

    mixed = default_simulation_output(settings, 2025, "My Fancy Scenario")
    assert mixed.name == "rest_of_season__scenario-my-fancy-scenario.json"
