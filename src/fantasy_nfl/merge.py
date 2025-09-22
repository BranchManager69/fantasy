from __future__ import annotations

from dataclasses import dataclass
import logging
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd

from .pbp import PbpAggregator
from .settings import AppSettings

STAT_COLUMNS = [
    "passing_yards",
    "passing_tds",
    "passing_int",
    "rushing_yards",
    "rushing_tds",
    "receptions",
    "receiving_yards",
    "receiving_tds",
    "fumbles_lost",
    "sacks",
    "fantasy_points",
    "fantasy_points_ppr",
]


@dataclass
class DataAssembler:
    settings: AppSettings

    @property
    def espn_out_dir(self) -> Path:
        return self.settings.data_root / "out" / "espn" / str(self.settings.espn_season)

    @property
    def nflverse_dir(self) -> Path:
        return self.settings.data_root / "raw" / "nflverse"

    def roster_enriched_path(self) -> Path:
        return self.espn_out_dir / "roster_enriched.csv"

    def weekly_output_path(self, season: int, week: Optional[int]) -> Path:
        if week is None:
            return self.espn_out_dir / f"weekly_stats_{season}.csv"
        return self.espn_out_dir / f"weekly_stats_{season}_week_{week}.csv"

    def merge_roster_players(self) -> pd.DataFrame:
        roster_path = self.espn_out_dir / "roster.csv"
        players_path = self.nflverse_dir / "players.csv"
        if not roster_path.exists():
            raise FileNotFoundError(f"Missing roster CSV at {roster_path}; run `fantasy espn normalize` first")
        if not players_path.exists():
            raise FileNotFoundError(
                f"Missing players master at {players_path}; run `fantasy nflverse pull --season <year>` first"
            )

        roster_df = pd.read_csv(roster_path)
        roster_df.rename(
            columns={
                "position": "espn_position",
                "status": "espn_status",
            },
            inplace=True,
        )
        players_df = pd.read_csv(players_path)

        roster_df["espn_player_id"] = pd.to_numeric(roster_df["espn_player_id"], errors="coerce")
        players_df["espn_id"] = pd.to_numeric(players_df["espn_id"], errors="coerce")

        merged = roster_df.merge(
            players_df[
                [
                    "gsis_id",
                    "espn_id",
                    "display_name",
                    "position",
                    "latest_team",
                    "status",
                    "pfr_id",
                    "pff_id",
                ]
            ],
            how="left",
            left_on="espn_player_id",
            right_on="espn_id",
        )

        merged.rename(
            columns={
                "display_name": "nflverse_display_name",
                "position": "nflverse_position",
                "status": "nflverse_status",
                "latest_team": "nflverse_team",
                "gsis_id": "player_id",
            },
            inplace=True,
        )

        merged_path = self.roster_enriched_path()
        merged_path.parent.mkdir(parents=True, exist_ok=True)
        merged.to_csv(merged_path, index=False)
        return merged

    def merge_with_weekly(self, season: int, week: Optional[int] = None) -> pd.DataFrame:
        roster = self.merge_roster_players()
        weekly_path = self.nflverse_dir / f"stats_player_week_{season}.csv"
        if not weekly_path.exists():
            LOGGER = logging.getLogger(__name__)
            LOGGER.warning(
                "Weekly stats file %s missing; generating from play-by-play data.", weekly_path
            )
            aggregator = PbpAggregator(self.settings)
            weekly_path = aggregator.build_weekly_stats(season)

        weekly = pd.read_csv(weekly_path)
        if week is not None:
            weekly = weekly.loc[weekly["week"] == week]

        weekly_subset = weekly[
            ["player_id", "season", "week"] + [col for col in STAT_COLUMNS if col in weekly.columns]
        ].copy()
        weekly_subset.rename(columns={"season": "stat_season", "week": "stat_week"}, inplace=True)

        merged = roster.merge(weekly_subset, how="left", on="player_id", suffixes=("", "_stat"))
        output_path = self.weekly_output_path(season, week)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        merged.to_csv(output_path, index=False)
        return merged
