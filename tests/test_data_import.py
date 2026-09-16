import gzip
import json
from pathlib import Path

import httpx
import pandas as pd
import pytest

from fantasy_nfl.merge import DataAssembler, normalize_weekly_stat_columns
from fantasy_nfl.nflverse import NflverseDownloader
from fantasy_nfl.normalize import normalize_roster
from fantasy_nfl.projection_providers import _espn_projection_rows
from fantasy_nfl.scoring import ScoreEngine, ScoringConfig
from fantasy_nfl.settings import AppSettings


def settings_for(data_root: Path) -> AppSettings:
    return AppSettings(None, None, None, None, "123", 2026, data_root, "INFO")


def test_current_nflverse_release_downloads_and_extracts(tmp_path, monkeypatch):
    requested = []

    def respond(request):
        requested.append(request.url.path)
        assert request.url.path == (
            "/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.csv.gz"
        )
        payload = b"player_id,season,week,passing_interceptions\n00-123,2026,1,2\n"
        return httpx.Response(200, content=gzip.compress(payload))

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        monkeypatch.setattr(httpx, "stream", client.stream)
        path = NflverseDownloader(settings_for(tmp_path)).fetch_weekly(2026)

    assert len(requested) == 1
    assert pd.read_csv(path).iloc[0]["passing_interceptions"] == 2
    assert not path.with_suffix(".csv.download").exists()


def test_modern_weekly_stats_survive_merge_and_scoring(tmp_path):
    settings = settings_for(tmp_path)
    espn_dir = tmp_path / "out" / "espn" / "2026"
    nflverse_dir = tmp_path / "raw" / "nflverse"
    espn_dir.mkdir(parents=True)
    nflverse_dir.mkdir(parents=True)
    pd.DataFrame([{
        "team_id": 1, "espn_player_id": 100, "player_name": "Test QB",
        "position": "QB", "lineup_slot": "QB", "status": "ACTIVE",
    }]).to_csv(espn_dir / "roster.csv", index=False)
    pd.DataFrame([{
        "gsis_id": "00-123", "espn_id": 100, "display_name": "Test QB",
        "position": "QB", "latest_team": "BUF", "status": "ACT",
        "pfr_id": "test", "pff_id": 100,
    }]).to_csv(nflverse_dir / "players.csv", index=False)
    modern = {
        "player_id": "00-123", "season": 2026, "week": 1,
        "passing_yards": 250, "passing_tds": 2, "passing_interceptions": 2,
        "passing_2pt_conversions": 1, "rushing_2pt_conversions": 2,
        "receiving_2pt_conversions": 3, "sacks_suffered": 4,
        "sack_fumbles_lost": 1, "rushing_fumbles_lost": 1,
        "fumbles_lost_total": 3,
    }
    pd.DataFrame([modern, dict(modern, week=2, passing_interceptions=9)]).to_csv(
        nflverse_dir / "stats_player_week_2026.csv", index=False
    )

    merged = DataAssembler(settings).merge_with_weekly(2026, week=1)
    assert len(merged) == 1
    row = merged.iloc[0]
    assert row["passing_int"] == 2
    assert row["passing_two_point_conversion"] == 1
    assert row["rushing_two_point_conversion"] == 2
    assert row["receiving_two_point_conversion"] == 3
    assert row["fumbles_lost"] == 3
    assert row["sacks"] == 4
    config_path = Path(__file__).resolve().parents[1] / "config" / "scoring.yaml"
    scored = ScoreEngine(settings, ScoringConfig.load(config_path)).score_dataframe(merged)
    # 250 passing yards / 25 + 2 TDs * 4 - 2 INTs * 2
    # + six combined two-point conversions * 2 - 3 lost fumbles * 2.
    assert scored.iloc[0]["score_total"] == pytest.approx(20)
    assert bool(scored.iloc[0]["counts_for_score"])


def test_stat_aliases_preserve_existing_legacy_values_and_fill_gaps():
    raw = pd.DataFrame({
        "passing_int": [4, None], "passing_interceptions": [1, 2],
        "fumbles_lost": [0, None], "fumbles_lost_total": [3, 1],
    })
    normalized = normalize_weekly_stat_columns(raw)
    assert normalized["passing_int"].tolist() == [4, 2]
    assert normalized["fumbles_lost"].tolist() == [0, 1]
    assert normalized["passing_interceptions"].tolist() == [1, 2]
    assert pd.isna(raw.iloc[1]["passing_int"])


def test_2026_scoring_counts_each_bonus_event_and_400_yard_game(tmp_path):
    raw = pd.DataFrame([{
        "passing_yards": 424, "passing_tds": 3, "passing_long_td": 2,
        "passing_interceptions": 1, "fumbles_lost_total": 1,
        "punt_return_tds": 2, "fumble_recovery_tds": 1,
        "lineup_slot": "QB", "espn_position": "QB",
    }])
    normalized = normalize_weekly_stat_columns(raw)
    assert normalized.iloc[0]["passing_400_yard_game"] == 1
    config_path = Path(__file__).resolve().parents[1] / "config" / "scoring-2026.yaml"
    scored = ScoreEngine(settings_for(tmp_path), ScoringConfig.load(config_path)).score_dataframe(normalized)
    # Whole 25-yard units (16), 3 TDs (12), 2 long TDs (2), 400+ bonus (1),
    # one INT (-2), one lost fumble (-2), two punt return TDs (12), recovery TD (6).
    assert scored.iloc[0]["score_total"] == pytest.approx(45)


def test_espn_backfill_keeps_conversion_and_bonus_categories_distinct(tmp_path):
    settings = settings_for(tmp_path)
    snapshot_dir = tmp_path / "raw" / "espn" / "2026"
    snapshot_dir.mkdir(parents=True)
    raw = {"teams": [{"roster": {"entries": [{
        "lineupSlotId": 0,
        "playerPoolEntry": {"player": {"id": 100, "stats": [{
            "scoringPeriodId": 1, "statSourceId": 0,
            "stats": {"19": 1, "26": 2, "44": 3, "36": 1, "101": 1, "102": 2},
        }]}},
    }]}}]}
    (snapshot_dir / "view-mRoster-week-1.json").write_text(json.dumps(raw))
    merged = pd.DataFrame([{"player_id": "00-123", "espn_player_id": 100}])
    row = DataAssembler(settings)._fill_missing_stats_with_espn(merged, 2026, 1).iloc[0]
    assert row["passing_two_point_conversion"] == 1
    assert row["rushing_two_point_conversion"] == 2
    assert row["receiving_two_point_conversion"] == 3
    assert row["rushing_long_td"] == 1
    assert row["kickoff_return_tds"] == 1
    assert row["punt_return_tds"] == 2


def test_espn_player_positions_are_distinct_from_lineup_slot_ids():
    def entry(player_id, position_id, slot_id):
        return {
            "lineupSlotId": slot_id,
            "playerPoolEntry": {"player": {
                "id": player_id, "fullName": "Test Player", "defaultPositionId": position_id,
                "stats": [{"scoringPeriodId": 1, "statSourceId": 1, "statSplitTypeId": 1, "stats": {}}],
            }},
        }

    raw = {"seasonId": 2026, "scoringPeriodId": 1, "teams": [{
        "id": 1, "roster": {"entries": [entry(100, 1, 0), entry(200, 16, 16)]},
    }]}
    roster = normalize_roster(raw)
    assert roster["position"].tolist() == ["QB", "D/ST"]
    assert roster["lineup_slot"].tolist() == ["QB", "D/ST"]
    projections = _espn_projection_rows(raw, 2026, 1)
    assert [row["espn_position"] for row in projections] == ["QB", "D/ST"]
