from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

import pandas as pd
import yaml

from .merge import DataAssembler
from .settings import AppSettings


@dataclass(frozen=True)
class BonusRule:
    threshold: float
    points: float


@dataclass(frozen=True)
class UnitRule:
    unit: float
    points: float


@dataclass(frozen=True)
class ScoringConfig:
    include_positions: set[str]
    weights: Dict[str, float]
    unit_scoring: Dict[str, UnitRule]
    bonuses: Dict[str, List[BonusRule]]
    position_modifiers: Dict[str, Dict[str, float]]

    @classmethod
    def load(cls, path: Path) -> "ScoringConfig":
        if not path.exists():
            raise FileNotFoundError(f"Scoring config not found at {path}")

        raw = yaml.safe_load(path.read_text()) or {}

        include_positions = {str(item).upper() for item in raw.get("include_positions", [])}
        weights = {str(k): float(v) for k, v in (raw.get("weights") or {}).items()}

        bonuses: Dict[str, List[BonusRule]] = {}
        for stat, entries in (raw.get("bonuses") or {}).items():
            rules: List[BonusRule] = []
            for entry in entries or []:
                if entry is None:
                    continue
                threshold = float(entry.get("threshold", 0))
                points = float(entry.get("points", 0))
                rules.append(BonusRule(threshold=threshold, points=points))
            bonuses[str(stat)] = rules

        unit_scoring: Dict[str, UnitRule] = {}
        for stat, spec in (raw.get("unit_scoring") or {}).items():
            if spec is None:
                continue
            unit = float(spec.get("unit", 0))
            if unit <= 0:
                raise ValueError(f"unit_scoring for stat '{stat}' must specify unit > 0")
            points = float(spec.get("points", 0))
            unit_scoring[str(stat)] = UnitRule(unit=unit, points=points)

        position_modifiers: Dict[str, Dict[str, float]] = {}
        for position, mapping in (raw.get("position_modifiers") or {}).items():
            if mapping is None:
                continue
            position_modifiers[str(position).upper()] = {
                str(stat): float(delta) for stat, delta in mapping.items()
            }

        return cls(
            include_positions=include_positions,
            weights=weights,
            unit_scoring=unit_scoring,
            bonuses=bonuses,
            position_modifiers=position_modifiers,
        )

    @property
    def required_stats(self) -> set[str]:
        stats: set[str] = set(self.weights.keys())
        stats.update(self.bonuses.keys())
        stats.update(self.unit_scoring.keys())
        for mapping in self.position_modifiers.values():
            stats.update(mapping.keys())
        return stats

    def inclusion_mask(self, lineup_slots: Iterable[str], positions: Iterable[str]) -> pd.Series:
        lineup_series = pd.Series(list(lineup_slots), dtype="string").fillna("").str.upper()
        if not self.include_positions:
            return pd.Series([True] * len(lineup_series.index), index=lineup_series.index)

        base_mask = lineup_series.isin(self.include_positions)

        # Fallback to player position only when the lineup slot is missing/empty.
        if "" in lineup_series.values:
            position_series = pd.Series(list(positions), dtype="string").fillna("").str.upper()
            empty_mask = lineup_series == ""
            if empty_mask.any():
                base_mask = base_mask | (empty_mask & position_series.isin(self.include_positions))

        return base_mask


class ScoreEngine:
    def __init__(self, settings: AppSettings, config: ScoringConfig) -> None:
        self.settings = settings
        self.config = config
        self._assembler = DataAssembler(settings)

    def weekly_scores_path(self, season: int, week: int | None) -> Path:
        out_dir = self._assembler.espn_out_dir
        if week is None:
            return out_dir / f"weekly_scores_{season}.csv"
        return out_dir / f"weekly_scores_{season}_week_{week}.csv"

    def score_week(self, season: int, week: int) -> Tuple[pd.DataFrame, Path]:
        weekly_path = self._assembler.weekly_output_path(season, week)
        if not weekly_path.exists():
            raise FileNotFoundError(
                f"Weekly dataset not found at {weekly_path}. Run `fantasy espn build-week --season {season} --week {week}` first."
            )

        df = pd.read_csv(weekly_path)
        self._rename_conflicting_columns(df)
        scored = self._apply_scoring(df)
        output_path = self.weekly_scores_path(season, week)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        scored.to_csv(output_path, index=False)
        return scored, output_path

    def score_dataframe(self, df: pd.DataFrame) -> pd.DataFrame:
        """Apply scoring rules to an arbitrary dataframe."""

        working = df.copy()
        self._rename_conflicting_columns(working)
        return self._apply_scoring(working)

    def _rename_conflicting_columns(self, df: pd.DataFrame) -> None:
        rename_map = {}
        if "fantasy_points" in df.columns:
            rename_map["fantasy_points"] = "nflverse_fantasy_points"
        if "fantasy_points_ppr" in df.columns:
            rename_map["fantasy_points_ppr"] = "nflverse_fantasy_points_ppr"
        if rename_map:
            df.rename(columns=rename_map, inplace=True)

    def _apply_scoring(self, df: pd.DataFrame) -> pd.DataFrame:
        scored = df.copy()

        required_stats = self.config.required_stats
        for stat in required_stats:
            if stat not in scored.columns:
                scored[stat] = 0.0
        for stat in required_stats:
            scored[stat] = pd.to_numeric(scored[stat], errors="coerce").fillna(0.0)

        lineup_slot_series = scored.get("lineup_slot", pd.Series(["" for _ in range(len(scored))]))
        position_series = scored.get("espn_position", pd.Series(["" for _ in range(len(scored))]))

        base_points = self._calculate_base(scored)
        bonus_points = self._calculate_bonuses(scored)
        position_points = self._calculate_position_modifiers(scored)

        total_points = base_points + bonus_points + position_points
        inclusion_mask = self.config.inclusion_mask(lineup_slot_series, position_series)

        scored["score_base"] = base_points
        scored["score_bonus"] = bonus_points
        scored["score_position"] = position_points
        scored["score_total"] = total_points
        scored["counts_for_score"] = inclusion_mask
        scored["fantasy_points"] = total_points.where(inclusion_mask, 0.0)

        return scored

    def _calculate_base(self, df: pd.DataFrame) -> pd.Series:
        if df.empty:
            return pd.Series(dtype="float")
        total = pd.Series(0.0, index=df.index)
        for stat, weight in self.config.weights.items():
            values = pd.to_numeric(df.get(stat, 0.0), errors="coerce").fillna(0.0)
            total = total.add(values * weight, fill_value=0.0)

        for stat, rule in self.config.unit_scoring.items():
            values = pd.to_numeric(df.get(stat, 0.0), errors="coerce").fillna(0.0)
            units = (values // rule.unit).astype(float)
            total = total.add(units * rule.points, fill_value=0.0)
        return total

    def _calculate_bonuses(self, df: pd.DataFrame) -> pd.Series:
        if df.empty:
            return pd.Series(dtype="float")
        bonuses = pd.Series(0.0, index=df.index)
        for stat, rules in self.config.bonuses.items():
            values = pd.to_numeric(df.get(stat, 0.0), errors="coerce").fillna(0.0)
            for rule in rules:
                bonuses += (values >= rule.threshold).astype(float) * rule.points
        return bonuses

    def _calculate_position_modifiers(self, df: pd.DataFrame) -> pd.Series:
        if df.empty:
            return pd.Series(dtype="float")
        modifiers = pd.Series(0.0, index=df.index)
        positions = df.get("espn_position", pd.Series(["" for _ in range(len(df))])).fillna("").str.upper()
        for position, mapping in self.config.position_modifiers.items():
            mask = positions == position
            if not mask.any():
                continue
            for stat, delta in mapping.items():
                values = pd.to_numeric(df.get(stat, 0.0), errors="coerce").fillna(0.0)
                modifiers.loc[mask] += values[mask] * delta
        return modifiers
