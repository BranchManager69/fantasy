from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd

from .settings import AppSettings


IDENTIFIER_COLUMNS = {
    "season",
    "stat_season",
    "stat_week",
    "scoring_period_id",
    "team_id",
    "espn_player_id",
    "player_name",
    "lineup_slot_id",
    "lineup_slot",
    "position_id",
    "espn_position",
    "position",
    "pro_team_id",
    "injury_status",
    "espn_status",
    "status",
    "acquisition_type",
    "player_id",
    "espn_id",
    "nflverse_display_name",
    "nflverse_position",
    "nflverse_team",
    "nflverse_status",
    "pfr_id",
    "pff_id",
}


def _numeric_stat_columns(df: pd.DataFrame) -> list[str]:
    columns: list[str] = []
    for column in df.columns:
        if column in IDENTIFIER_COLUMNS:
            continue
        series = df[column]
        if pd.api.types.is_numeric_dtype(series):
            columns.append(column)
    return columns


@dataclass
class ProjectionBaselineBuilder:
    settings: AppSettings
    lookback_weeks: int = 3

    def _default_stat_columns(self, season: int) -> list[str]:
        out_dir = self._espn_out_dir(season)
        for path in sorted(out_dir.glob(f"weekly_stats_{season}_week_*.csv")):
            try:
                sample = pd.read_csv(path, nrows=200)
            except Exception:
                continue
            columns = _numeric_stat_columns(sample)
            if columns:
                return columns
        return []

    def _espn_out_dir(self, season: int) -> Path:
        return self.settings.data_root / "out" / "espn" / str(season)

    def _projections_in_dir(self, season: int) -> Path:
        return self.settings.data_root / "in" / "projections" / str(season)

    def _weekly_stats_path(self, season: int, week: int) -> Path:
        return self._espn_out_dir(season) / f"weekly_stats_{season}_week_{week}.csv"

    def _roster_path(self, season: int) -> Path:
        return self._espn_out_dir(season) / "roster.csv"

    def _load_history(self, season: int, weeks: Iterable[int]) -> pd.DataFrame:
        frames: list[pd.DataFrame] = []
        for week in weeks:
            path = self._weekly_stats_path(season, week)
            if not path.exists():
                continue
            df = pd.read_csv(path)
            df["source_week"] = week
            frames.append(df)
        if not frames:
            return pd.DataFrame()
        return pd.concat(frames, ignore_index=True)

    def _load_roster(self, season: int) -> pd.DataFrame:
        path = self._roster_path(season)
        if not path.exists():
            return pd.DataFrame()
        df = pd.read_csv(path)
        # normalize key columns
        df.rename(columns={"position": "espn_position"}, inplace=True)
        df["espn_position"] = df.get("espn_position", "").astype(str).str.upper()
        df["lineup_slot"] = df.get("lineup_slot", "").astype(str).str.upper()
        return df

    def build_week(
        self,
        season: int,
        week: int,
        output_path: Optional[Path] = None,
    ) -> pd.DataFrame:
        if week <= 0:
            raise ValueError("Week must be >= 1")

        lookback = max(0, min(self.lookback_weeks, week - 1))
        history_weeks = list(range(max(1, week - lookback), week)) if lookback else []
        history = self._load_history(season, history_weeks)

        roster = self._load_roster(season)

        stat_columns: list[str] = []
        aggregated: pd.DataFrame

        if not history.empty:
            stat_columns = _numeric_stat_columns(history)
            grouped = history.groupby("espn_player_id", as_index=False)[stat_columns].mean()

            latest_meta = (
                history.sort_values(["espn_player_id", "source_week"])
                .drop_duplicates("espn_player_id", keep="last")
                .loc[:, [
                    "espn_player_id",
                    "team_id",
                    "player_name",
                    "lineup_slot",
                    "espn_position",
                ]]
            )

            aggregated = grouped.merge(latest_meta, on="espn_player_id", how="left")
        else:
            aggregated = pd.DataFrame(columns=["espn_player_id"])

        if roster.empty:
            baseline = aggregated.copy()
        else:
            roster_subset = roster.loc[
                :,
                [
                    "team_id",
                    "espn_player_id",
                    "player_name",
                    "lineup_slot",
                    "espn_position",
                ],
            ].drop_duplicates("espn_player_id")

            baseline = roster_subset.merge(
                aggregated,
                on="espn_player_id",
                how="left",
                suffixes=("", "_agg"),
            )

            for column in ("team_id", "player_name", "lineup_slot", "espn_position"):
                agg_column = f"{column}_agg"
                if agg_column in baseline.columns:
                    baseline[column] = baseline[column].fillna(baseline[agg_column])
                    baseline.drop(columns=[agg_column], inplace=True)

        if baseline.empty:
            # No roster and no history; nothing to project.
            baseline = aggregated.copy()

        # Ensure metadata columns are present.
        for column in ("team_id", "player_name", "lineup_slot", "espn_position"):
            if column not in baseline.columns:
                baseline[column] = ""

        if not stat_columns:
            stat_columns = self._default_stat_columns(season)

        if stat_columns:
            for column in stat_columns:
                if column in baseline.columns:
                    baseline[column] = pd.to_numeric(baseline[column], errors="coerce").fillna(0.0)
                else:
                    baseline[column] = 0.0

        baseline["season"] = season
        baseline["week"] = week

        # Reorder columns for readability.
        ordered_cols = [
            "season",
            "week",
            "team_id",
            "espn_player_id",
            "player_name",
            "espn_position",
            "lineup_slot",
        ]
        stat_cols_sorted = sorted([c for c in baseline.columns if c not in ordered_cols])
        final_cols = ordered_cols + stat_cols_sorted
        baseline = baseline.loc[:, final_cols]

        if output_path is not None:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            baseline.to_csv(output_path, index=False)

        return baseline

    def build_range(
        self,
        season: int,
        start_week: int,
        end_week: int,
    ) -> dict[int, Path]:
        if end_week < start_week:
            raise ValueError("end_week must be >= start_week")

        output_dir = self._projections_in_dir(season)
        output_dir.mkdir(parents=True, exist_ok=True)

        results: dict[int, Path] = {}
        for week in range(start_week, end_week + 1):
            path = output_dir / f"baseline_week_{week}.csv"
            self.build_week(season, week, path)
            results[week] = path
        return results
