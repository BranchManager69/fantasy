import importlib
from pathlib import Path

import pandas as pd
import pytest
import click
from click.testing import CliRunner

from fantasy_nfl.settings import AppSettings

cli_module = importlib.import_module("fantasy_nfl.cli")


@pytest.mark.parametrize(
    "season,extra_args,expected_config,expected_size",
    [
        (2026, [], "config/scoring-2026.yaml", 14),
        (2025, [], "config/scoring.yaml", 14),
        (2026, ["--config", "custom.yaml", "--league-size", "10"], "custom.yaml", 10),
    ],
)
def test_refresh_uses_season_config_and_refreshed_league_size(
    tmp_path, monkeypatch, season, extra_args, expected_config, expected_size
):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "config").mkdir()
    for name in ("config/scoring.yaml", "config/scoring-2026.yaml", "custom.yaml"):
        (tmp_path / name).write_text("weights: {passing_tds: 4}\n")
    settings = AppSettings(None, None, None, None, "123", season, tmp_path / "data", "INFO")
    monkeypatch.setattr(cli_module, "get_settings", lambda env_file: settings)
    calls = {"refresh": [], "projections": [], "trade": [], "rankings": [], "sim": []}

    def refresh(**kwargs):
        calls["refresh"].append(kwargs)
        out = settings.data_root / "out" / "espn" / str(season)
        out.mkdir(parents=True)
        pd.DataFrame([{
            "size": 14, "regular_season_matchups": 14, "matchup_period_length": 1,
        }]).to_csv(out / "league_settings.csv", index=False)
        return 2

    monkeypatch.setattr(cli_module.refresh_week, "callback", refresh)
    monkeypatch.setattr(cli_module.projections_baseline, "callback", lambda **kwargs: None)
    for command, name in [
        (cli_module.projections_apply, "projections"),
        (cli_module.calc_trade_chart, "trade"),
        (cli_module.calc_redraft_rankings, "rankings"),
        (cli_module.sim_rest_of_season, "sim"),
    ]:
        monkeypatch.setattr(command, "callback", lambda name=name, **kwargs: calls[name].append(kwargs))

    result = CliRunner().invoke(cli_module.cli, ["refresh-all", *extra_args])
    assert result.exit_code == 0, result.output
    assert calls["refresh"][0]["season"] == season
    assert calls["refresh"][0]["config_path"] == Path(expected_config)
    assert len(calls["projections"]) == 13
    assert all(call["config_path"] == Path(expected_config) for call in calls["projections"])
    assert calls["trade"][0]["league_size"] == expected_size
    assert calls["rankings"][0]["league_size"] == expected_size
    assert calls["sim"][0]["end_week"] == 14


def test_refresh_does_not_guess_league_size_when_settings_are_missing(tmp_path):
    settings = AppSettings(None, None, None, None, "123", 2026, tmp_path, "INFO")
    with pytest.raises(click.ClickException, match="supply --league-size explicitly"):
        cli_module._resolve_league_size(settings, 2026, None)
    assert cli_module._resolve_league_size(settings, 2026, 14) == 14
