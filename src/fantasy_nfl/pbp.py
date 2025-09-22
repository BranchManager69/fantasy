from __future__ import annotations

import gzip
import io
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Dict

import httpx
import pandas as pd

from .settings import AppSettings

LOGGER = logging.getLogger(__name__)

PBP_URL_TEMPLATE = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{season}.csv.gz"

PASSING_COLUMNS: Dict[str, str] = {
    "passing_yards": "passing_yards",
    "pass_touchdown": "passing_tds",
    "interception": "passing_int",
    "sack": "sacks",
}

RUSHING_COLUMNS: Dict[str, str] = {
    "rushing_yards": "rushing_yards",
    "rush_touchdown": "rushing_tds",
}

RECEIVING_COLUMNS: Dict[str, str] = {
    "complete_pass": "receptions",
    "receiving_yards": "receiving_yards",
    "pass_touchdown": "receiving_tds",
}

FUMBLE_COLUMNS: Dict[str, str] = {
    "fumble_lost": "fumbles_lost",
}


@dataclass
class PbpAggregator:
    settings: AppSettings

    @property
    def base_dir(self) -> Path:
        return self.settings.data_root / "raw" / "nflverse"

    def pbp_path(self, season: int) -> Path:
        return self.base_dir / f"play_by_play_{season}.csv"

    def fetch_pbp(self, season: int, force: bool = False) -> Path:
        dest = self.pbp_path(season)
        if dest.exists() and not force:
            LOGGER.info("Using cached pbp file %s", dest)
            return dest

        url = PBP_URL_TEMPLATE.format(season=season)
        dest.parent.mkdir(parents=True, exist_ok=True)
        LOGGER.info("Downloading PBP %s", url)
        with httpx.stream("GET", url, follow_redirects=True, timeout=120.0) as response:
            response.raise_for_status()
            gz_bytes = response.read()

        LOGGER.info("Extracting pbp to %s", dest)
        with gzip.GzipFile(fileobj=io.BytesIO(gz_bytes)) as gz, dest.open("wb") as out:
            out.write(gz.read())

        return dest

    def build_weekly_stats(self, season: int, force: bool = False) -> Path:
        output = self.base_dir / f"stats_player_week_{season}_pbp.csv"
        if output.exists() and not force:
            LOGGER.info("Using cached pbp-derived weekly stats %s", output)
            return output

        pbp_file = self.fetch_pbp(season, force=force)
        LOGGER.info("Aggregating weekly stats from %s", pbp_file)
        usecols = {
            "season",
            "week",
            "passer_player_id",
            "rusher_player_id",
            "receiver_player_id",
            "fumbled_1_player_id",
            "passing_yards",
            "pass_touchdown",
            "interception",
            "sack",
            "rushing_yards",
            "rush_touchdown",
            "complete_pass",
            "receiving_yards",
            "fumble_lost",
        }
        df = pd.read_csv(pbp_file, usecols=list(usecols), low_memory=False)

        frames = []
        frames.append(self._aggregate_role(df, "passer_player_id", PASSING_COLUMNS))
        frames.append(self._aggregate_role(df, "rusher_player_id", RUSHING_COLUMNS))
        frames.append(self._aggregate_role(df, "receiver_player_id", RECEIVING_COLUMNS))
        frames.append(self._aggregate_role(df, "fumbled_1_player_id", FUMBLE_COLUMNS))

        merged = self._merge_frames(frames)
        merged.to_csv(output, index=False)
        LOGGER.info("Wrote pbp weekly stats → %s", output)
        return output

    @staticmethod
    def _aggregate_role(df: pd.DataFrame, id_col: str, mapping: Dict[str, str]) -> pd.DataFrame:
        subset = df[["season", "week", id_col] + list(mapping.keys())].copy()
        subset = subset.dropna(subset=[id_col])
        subset[id_col] = subset[id_col].astype(str)
        for col in mapping.keys():
            subset[col] = subset[col].fillna(0)
        grouped = (
            subset.groupby([id_col, "season", "week"], as_index=False)[list(mapping.keys())].sum()
        )
        grouped.rename(columns={id_col: "player_id", **mapping}, inplace=True)
        return grouped

    @staticmethod
    def _merge_frames(frames: list[pd.DataFrame]) -> pd.DataFrame:
        from functools import reduce

        def merge_two(left: pd.DataFrame, right: pd.DataFrame) -> pd.DataFrame:
            if left.empty:
                return right
            if right.empty:
                return left
            return left.merge(right, how="outer", on=["player_id", "season", "week"])

        merged = reduce(merge_two, frames)
        stat_cols = [col for col in merged.columns if col not in {"player_id", "season", "week"}]
        merged[stat_cols] = merged[stat_cols].fillna(0)
        return merged
