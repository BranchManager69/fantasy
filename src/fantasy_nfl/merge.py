from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import shutil
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd

from .pbp import PbpAggregator
from .normalize import LINEUP_SLOT_NAMES
from .settings import AppSettings

STAT_COLUMNS = [
    "passing_yards",
    "passing_tds",
    "passing_int",
    "passing_two_point_conversion",
    "passing_long_td",
    "passing_400_yard_game",
    "rushing_yards",
    "rushing_tds",
    "rushing_two_point_conversion",
    "rushing_long_td",
    "receptions",
    "receiving_yards",
    "receiving_tds",
    "receiving_two_point_conversion",
    "receiving_long_td",
    "kickoff_return_tds",
    "punt_return_tds",
    "fumble_recovery_tds",
    "blocked_kick_return_tds",
    "interception_return_tds",
    "fumble_return_tds",
    "two_point_returns",
    "one_point_safeties",
    "fumbles_lost",
    "sacks",
    "fantasy_points",
    "fantasy_points_ppr",
]


ESPN_STAT_CODE_MAP = {
    "passing_yards": "3",
    "passing_tds": "4",
    "passing_int": "20",
    "passing_two_point_conversion": "19",
    "passing_long_td": "16",  # 50+ yard passing TD bonus
    "passing_400_yard_game": "18",
    "rushing_yards": "24",
    "rushing_tds": "25",
    "rushing_two_point_conversion": "26",
    "rushing_long_td": "36",
    "receptions": "53",
    "receiving_yards": "42",
    "receiving_tds": "43",
    "receiving_two_point_conversion": "44",
    "receiving_long_td": "46",
    "fumbles_lost": "72",
    "kickoff_return_tds": "101",
    "punt_return_tds": "102",
    "fumble_recovery_tds": "63",
    "blocked_kick_return_tds": "93",
    "interception_return_tds": "103",
    "fumble_return_tds": "104",
    "two_point_returns": "206",
    "one_point_safeties": "209",
}


# nflverse's stats_player release uses these names; the scorer and historical
# play-by-play artifacts use the names on the left. Normalize before selecting
# STAT_COLUMNS so interceptions, conversions, and lost fumbles survive ingestion.
NFLVERSE_STAT_ALIASES = {
    "passing_int": "passing_interceptions",
    "passing_two_point_conversion": "passing_2pt_conversions",
    "rushing_two_point_conversion": "rushing_2pt_conversions",
    "receiving_two_point_conversion": "receiving_2pt_conversions",
    "fumbles_lost": "fumbles_lost_total",
    "sacks": "sacks_suffered",
}


def normalize_weekly_stat_columns(weekly: pd.DataFrame) -> pd.DataFrame:
    normalized = weekly.copy()
    for target, source in NFLVERSE_STAT_ALIASES.items():
        if source not in normalized.columns:
            continue
        values = pd.to_numeric(normalized[source], errors="coerce")
        if target in normalized.columns:
            normalized[target] = pd.to_numeric(normalized[target], errors="coerce").fillna(values)
        else:
            normalized[target] = values
    if "passing_400_yard_game" not in normalized.columns and "passing_yards" in normalized.columns:
        yards = pd.to_numeric(normalized["passing_yards"], errors="coerce")
        normalized["passing_400_yard_game"] = (yards >= 400).astype(float).where(yards.notna())
    return normalized


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
            pbp_path = aggregator.build_weekly_stats(season)
            if pbp_path.exists():
                try:
                    shutil.copy2(pbp_path, weekly_path)
                except OSError:
                    LOGGER.exception(
                        "Failed to mirror %s to %s; continuing with play-by-play artifact only.",
                        pbp_path,
                        weekly_path,
                    )
                    weekly_path = pbp_path
            else:
                weekly_path = pbp_path

        weekly = normalize_weekly_stat_columns(pd.read_csv(weekly_path))
        if week is not None:
            weekly = weekly.loc[weekly["week"] == week]

        weekly_subset = weekly[
            ["player_id", "season", "week"] + [col for col in STAT_COLUMNS if col in weekly.columns]
        ].copy()
        weekly_subset.rename(columns={"season": "stat_season", "week": "stat_week"}, inplace=True)

        merged = roster.merge(weekly_subset, how="left", on="player_id", suffixes=("", "_stat"))

        if week is not None:
            merged = self._fill_missing_stats_with_espn(merged, season, week)

        output_path = self.weekly_output_path(season, week)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        merged.to_csv(output_path, index=False)
        return merged

    def _fill_missing_stats_with_espn(self, merged: pd.DataFrame, season: int, week: int) -> pd.DataFrame:
        """Populate missing stat columns using ESPN roster snapshots for the week."""

        snapshot_path = self.settings.data_root / "raw" / "espn" / str(season) / f"view-mRoster-week-{week}.json"
        if not snapshot_path.exists():
            LOGGER = logging.getLogger(__name__)
            LOGGER.warning("ESPN week snapshot %s missing; cannot backfill stats.", snapshot_path)
            return merged

        try:
            snapshot = json.loads(snapshot_path.read_text())
        except json.JSONDecodeError:
            LOGGER = logging.getLogger(__name__)
            LOGGER.warning("Failed to parse %s; skipping ESPN stat backfill.", snapshot_path)
            return merged

        espn_stats: dict[str, dict[str, float]] = {}
        espn_lineups: dict[str, int] = {}
        for team in snapshot.get("teams", []):
            entries = team.get("roster", {}).get("entries", [])
            for entry in entries:
                player_entry = entry.get("playerPoolEntry", {})
                player = player_entry.get("player", {})
                espn_player_id = player.get("id")
                if espn_player_id is None:
                    continue
                lineup_slot_id = entry.get("lineupSlotId")
                if lineup_slot_id is not None:
                    espn_lineups[str(espn_player_id)] = lineup_slot_id
                stats_list = player.get("stats", [])
                stat_record = next(
                    (
                        item
                        for item in stats_list
                        if item.get("scoringPeriodId") == week and item.get("statSourceId") == 0
                    ),
                    None,
                )
                if not stat_record:
                    continue
                espn_stats[str(espn_player_id)] = stat_record.get("stats", {})

        if not espn_stats:
            return merged

        for column in ESPN_STAT_CODE_MAP.keys():
            if column not in merged.columns:
                merged[column] = float("nan")

        conversion_columns = {
            "passing_two_point_conversion",
            "rushing_two_point_conversion",
            "receiving_two_point_conversion",
        }

        for idx in merged.index:
            player_id = merged.at[idx, "player_id"]
            espn_player_id = merged.at[idx, "espn_player_id"]
            stats = None
            if not isinstance(espn_player_id, str):
                key = str(int(espn_player_id)) if pd.notna(espn_player_id) else None
            else:
                key = espn_player_id
            if key and key in espn_stats:
                stats = espn_stats[key]
            if not stats and isinstance(player_id, str) and player_id.endswith(".0"):
                stats = espn_stats.get(player_id.split(".")[0])
            if not stats:
                continue

            for column, code in ESPN_STAT_CODE_MAP.items():
                value = stats.get(code)
                if value is None:
                    continue
                merged.at[idx, column] = float(value)

            # Ensure we stamp the scoring week if nflverse left it blank.
            stat_week_value = merged.at[idx, "stat_week"] if "stat_week" in merged.columns else None
            if pd.isna(stat_week_value) or str(stat_week_value).strip() == "":
                merged.at[idx, "stat_week"] = week

            # Align lineup slots and scoring period with ESPN snapshot for this week.
            slot_id = None
            if key and key in espn_lineups:
                slot_id = espn_lineups[key]
            elif isinstance(player_id, str) and player_id.endswith(".0"):
                slot_id = espn_lineups.get(player_id.split(".")[0])

            if slot_id is not None:
                merged.at[idx, "lineup_slot_id"] = slot_id
                merged.at[idx, "lineup_slot"] = LINEUP_SLOT_NAMES.get(slot_id, str(slot_id))

            if "scoring_period_id" in merged.columns:
                merged.at[idx, "scoring_period_id"] = week

        return merged
