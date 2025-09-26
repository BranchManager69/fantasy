from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional

import pandas as pd
import yaml

from .scoring import ScoreEngine, ScoringConfig
from .settings import AppSettings


def _ensure_columns(df: pd.DataFrame, columns: Dict[str, object]) -> None:
    for column, default in columns.items():
        if column not in df.columns:
            df[column] = default
        df[column] = df[column].fillna(default)


def _load_yaml(path: Optional[Path]) -> dict:
    if path is None or not path.exists():
        return {}
    raw = yaml.safe_load(path.read_text())
    return raw or {}


@dataclass
class ProjectionManager:
    settings: AppSettings
    scoring_config: ScoringConfig

    def __post_init__(self) -> None:
        self._engine = ScoreEngine(self.settings, self.scoring_config)

    def load_baseline(self, path: Path, season: int, week: int) -> pd.DataFrame:
        if not path.exists():
            raise FileNotFoundError(f"Projection baseline not found at {path}")

        df = pd.read_csv(path)

        df["season"] = season
        df["week"] = week

        required = {"season", "week", "espn_player_id"}
        missing = required - set(df.columns)
        if missing:
            raise ValueError(f"Projection baseline missing columns: {', '.join(sorted(missing))}")

        identifier_cols = {
            "team_id": "",
            "player_name": "",
            "espn_position": "",
            "lineup_slot": "",
        }
        _ensure_columns(df, identifier_cols)
        df["espn_position"] = df["espn_position"].astype(str).str.upper()
        df["lineup_slot"] = df["lineup_slot"].astype(str).str.upper()

        return df

    def load_manual_overrides(self, path: Optional[Path]) -> pd.DataFrame:
        if path is None or not path.exists():
            return pd.DataFrame()
        overrides = pd.read_csv(path)
        if overrides.empty:
            return overrides
        required = {"season", "week", "espn_player_id"}
        missing = required - set(overrides.columns)
        if missing:
            raise ValueError(
                f"Manual override file {path} missing columns: {', '.join(sorted(missing))}"
            )
        _ensure_columns(overrides, {"espn_position": "", "lineup_slot": ""})
        overrides["espn_position"] = overrides["espn_position"].astype(str).str.upper()
        overrides["lineup_slot"] = overrides["lineup_slot"].astype(str).str.upper()
        return overrides

    def apply_manual_overrides(self, baseline: pd.DataFrame, overrides: pd.DataFrame) -> pd.DataFrame:
        if overrides.empty:
            return baseline

        merge_cols = ["season", "week", "espn_player_id"]
        baseline = baseline.set_index(merge_cols)
        overrides = overrides.set_index(merge_cols)

        aligned = overrides.reindex(columns=baseline.columns, fill_value=pd.NA)
        baseline.update(aligned)
        baseline.reset_index(inplace=True)
        return baseline

    def apply_assumptions(self, df: pd.DataFrame, config_path: Optional[Path]) -> pd.DataFrame:
        config = _load_yaml(config_path)
        if not config:
            return df

        result = df.copy()
        multipliers = config.get("stat_multipliers", {})
        additions = config.get("stat_additions", {})

        for stat, multiplier in (multipliers.get("global", {}) or {}).items():
            if stat in result.columns:
                result[stat] = pd.to_numeric(result[stat], errors="coerce").fillna(0.0) * float(multiplier)

        for stat, delta in (additions.get("global", {}) or {}).items():
            if stat in result.columns:
                result[stat] = (
                    pd.to_numeric(result[stat], errors="coerce").fillna(0.0) + float(delta)
                )

        position_multipliers = multipliers.get("positions", {}) or {}
        position_additions = additions.get("positions", {}) or {}

        if position_multipliers or position_additions:
            positions = result.get("espn_position", pd.Series([], dtype="string")).astype(str).str.upper()

            for position, mapping in position_multipliers.items():
                mask = positions == str(position).upper()
                if not mask.any():
                    continue
                for stat, multiplier in (mapping or {}).items():
                    if stat in result.columns:
                        result.loc[mask, stat] = pd.to_numeric(result.loc[mask, stat], errors="coerce").fillna(0.0) * float(multiplier)

            for position, mapping in position_additions.items():
                mask = positions == str(position).upper()
                if not mask.any():
                    continue
                for stat, delta in (mapping or {}).items():
                    if stat in result.columns:
                        result.loc[mask, stat] = (
                            pd.to_numeric(result.loc[mask, stat], errors="coerce").fillna(0.0) + float(delta)
                        )

        return result

    def build_week_projection(
        self,
        season: int,
        week: int,
        baseline_path: Path,
        manual_override_path: Optional[Path],
        assumptions_path: Optional[Path],
        output_path: Path,
    ) -> pd.DataFrame:
        baseline = self.load_baseline(baseline_path, season, week)
        assumed = self.apply_assumptions(baseline, assumptions_path)
        overrides = self.load_manual_overrides(manual_override_path)
        combined = self.apply_manual_overrides(assumed, overrides)

        scored = self._engine.score_dataframe(combined)
        scored["projected_points"] = scored["score_total"]

        output_path.parent.mkdir(parents=True, exist_ok=True)
        scored.to_csv(output_path, index=False)
        return scored
