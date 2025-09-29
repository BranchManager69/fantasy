"""Scenario overlay storage and loading utilities."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

BASELINE_SCENARIO_ID = "baseline"


def _coerce_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class ScenarioMetadata:
    scenario_id: str
    season: int
    label: Optional[str] = None
    description: Optional[str] = None
    path: Optional[Path] = None
    updated_at: Optional[str] = None
    is_default: bool = False

    def label_or_id(self) -> str:
        return self.label or self.scenario_id


@dataclass
class TeamLineupOverride:
    team_id: int
    entries: List[Dict[str, Any]] = field(default_factory=list)

    def normalized_entries(
        self,
        *,
        value_key: str,
    ) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        for raw in self.entries:
            entry = {
                "team_id": self.team_id,
                "espn_player_id": raw.get("espn_player_id"),
                "player_name": raw.get("player_name", ""),
                "lineup_slot": raw.get("lineup_slot", ""),
                "espn_position": raw.get("espn_position", ""),
                "counts_for_score": bool(raw.get("counts_for_score", True)),
            }
            value = raw.get(value_key)
            if value is None:
                alt_value = raw.get("points")
                if alt_value is None and value_key == "score_total":
                    alt_value = raw.get("projected_points")
                elif alt_value is None and value_key == "projected_points":
                    alt_value = raw.get("score_total")
                value = alt_value
            entry[value_key] = _coerce_float(value) or 0.0

            if value_key == "score_total":
                for bonus_key in ("score_base", "score_bonus", "score_position"):
                    bonus_value = raw.get(bonus_key)
                    if bonus_value is not None:
                        entry[bonus_key] = _coerce_float(bonus_value)
            normalized.append(entry)
        return normalized


@dataclass
class CompletedWeekOverride:
    week: int
    team_lineups: Dict[int, TeamLineupOverride] = field(default_factory=dict)
    matchup_overrides: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, week: int, payload: Dict[str, Any]) -> "CompletedWeekOverride":
        teams_payload = payload.get("teams") or {}
        team_lineups: Dict[int, TeamLineupOverride] = {}
        if isinstance(teams_payload, dict):
            for team_id_raw, team_payload in teams_payload.items():
                team_id = _coerce_int(team_id_raw)
                if team_id is None:
                    continue
                raw_entries: Iterable[Dict[str, Any]]
                if isinstance(team_payload, dict):
                    raw_entries = team_payload.get("entries") or []
                elif isinstance(team_payload, list):
                    raw_entries = team_payload
                else:
                    continue
                entries = [dict(entry) for entry in raw_entries if isinstance(entry, dict)]
                team_lineups[team_id] = TeamLineupOverride(team_id=team_id, entries=entries)

        matchups_payload = payload.get("matchups") or {}
        matchup_overrides: Dict[str, Dict[str, Any]] = {}
        if isinstance(matchups_payload, dict):
            for matchup_id_raw, matchup_payload in matchups_payload.items():
                matchup_id = str(matchup_id_raw)
                if not isinstance(matchup_payload, dict):
                    continue
                normalized: Dict[str, Any] = {}
                for key in ("home_team_id", "away_team_id"):
                    coerced = _coerce_int(matchup_payload.get(key))
                    if coerced is not None:
                        normalized[key] = coerced
                for key in ("home_points", "away_points"):
                    coerced = _coerce_float(matchup_payload.get(key))
                    if coerced is not None:
                        normalized[key] = coerced
                winner = matchup_payload.get("winner")
                if isinstance(winner, str) and winner:
                    normalized["winner"] = winner.upper()
                notes = matchup_payload.get("notes")
                if isinstance(notes, str) and notes:
                    normalized["notes"] = notes
                matchup_overrides[matchup_id] = normalized

        return cls(week=week, team_lineups=team_lineups, matchup_overrides=matchup_overrides)

    def teams_with_overrides(self) -> List[int]:
        return list(self.team_lineups.keys())

    def as_rows(self) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        for lineup in self.team_lineups.values():
            rows.extend(lineup.normalized_entries(value_key="score_total"))
        return rows


@dataclass
class ProjectionWeekOverride:
    week: int
    team_lineups: Dict[int, TeamLineupOverride] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, week: int, payload: Dict[str, Any]) -> "ProjectionWeekOverride":
        teams_payload = payload.get("teams") or {}
        team_lineups: Dict[int, TeamLineupOverride] = {}
        if isinstance(teams_payload, dict):
            for team_id_raw, team_payload in teams_payload.items():
                team_id = _coerce_int(team_id_raw)
                if team_id is None:
                    continue
                raw_entries: Iterable[Dict[str, Any]]
                if isinstance(team_payload, dict):
                    raw_entries = team_payload.get("entries") or []
                elif isinstance(team_payload, list):
                    raw_entries = team_payload
                else:
                    continue
                entries = [dict(entry) for entry in raw_entries if isinstance(entry, dict)]
                team_lineups[team_id] = TeamLineupOverride(team_id=team_id, entries=entries)
        return cls(week=week, team_lineups=team_lineups)

    def teams_with_overrides(self) -> List[int]:
        return list(self.team_lineups.keys())

    def as_rows(self) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        for lineup in self.team_lineups.values():
            rows.extend(lineup.normalized_entries(value_key="projected_points"))
        return rows


@dataclass
class ScenarioOverlay:
    metadata: ScenarioMetadata
    completed_weeks: Dict[int, CompletedWeekOverride] = field(default_factory=dict)
    projection_weeks: Dict[int, ProjectionWeekOverride] = field(default_factory=dict)

    @property
    def scenario_id(self) -> str:
        return self.metadata.scenario_id

    def has_completed_week(self, week: int) -> bool:
        return week in self.completed_weeks

    def get_completed_week(self, week: int) -> Optional[CompletedWeekOverride]:
        return self.completed_weeks.get(week)

    def has_projection_week(self, week: int) -> bool:
        return week in self.projection_weeks

    def get_projection_week(self, week: int) -> Optional[ProjectionWeekOverride]:
        return self.projection_weeks.get(week)

    def override_summary(self) -> Dict[str, Any]:
        return {
            "scenario_id": self.metadata.scenario_id,
            "season": self.metadata.season,
            "completed_weeks": sorted(self.completed_weeks.keys()),
            "projection_weeks": sorted(self.projection_weeks.keys()),
        }

    @classmethod
    def empty(cls, season: int, scenario_id: str = BASELINE_SCENARIO_ID) -> "ScenarioOverlay":
        meta = ScenarioMetadata(
            scenario_id=scenario_id,
            season=season,
            label="Baseline",
            description="Official ESPN dataset (no overlays)",
            is_default=True,
        )
        return cls(metadata=meta)


class OverlayStore:
    """File-backed overlay storage for scenarios."""

    def __init__(self, data_root: Path) -> None:
        self.data_root = data_root
        self.base_path = self.data_root / "overlays"

    def _season_dir(self, season: int) -> Path:
        return self.base_path / str(season)

    def list_scenarios(
        self,
        season: Optional[int] = None,
        *,
        include_baseline: bool = True,
    ) -> List[ScenarioMetadata]:
        if not self.base_path.exists():
            return [ScenarioOverlay.empty(season or 0).metadata] if include_baseline and season else []

        seasons: Iterable[int]
        if season is not None:
            seasons = [season]
        else:
            seasons = [
                int(entry.name)
                for entry in self.base_path.iterdir()
                if entry.is_dir() and entry.name.isdigit()
            ]
            seasons = sorted(seasons, reverse=True)

        items: List[ScenarioMetadata] = []
        for season_value in seasons:
            season_dir = self._season_dir(season_value)
            if not season_dir.exists():
                continue
            for file in season_dir.glob("*.json"):
                try:
                    raw = json.loads(file.read_text())
                except json.JSONDecodeError:
                    continue
                scenario_id = str(raw.get("scenario_id") or file.stem)
                label = raw.get("label") if isinstance(raw.get("label"), str) else None
                description = raw.get("description") if isinstance(raw.get("description"), str) else None
                updated_at = raw.get("updated_at") if isinstance(raw.get("updated_at"), str) else None
                is_default = bool(raw.get("is_default", False))
                items.append(
                    ScenarioMetadata(
                        scenario_id=scenario_id,
                        season=season_value,
                        label=label,
                        description=description,
                        path=file,
                        updated_at=updated_at,
                        is_default=is_default,
                    )
                )
            if include_baseline:
                baseline = ScenarioOverlay.empty(season_value).metadata
                items.append(baseline)

        if season is not None and include_baseline and all(
            meta.scenario_id != BASELINE_SCENARIO_ID for meta in items
        ):
            items.append(ScenarioOverlay.empty(season).metadata)

        # Stable sort: newest season first, baseline last for each season
        items.sort(
            key=lambda meta: (
                -meta.season,
                meta.scenario_id == BASELINE_SCENARIO_ID,
                meta.label_or_id().lower(),
            )
        )
        return items

    def load_overlay(self, season: int, scenario_id: Optional[str]) -> ScenarioOverlay:
        if not scenario_id or scenario_id == BASELINE_SCENARIO_ID:
            return ScenarioOverlay.empty(season, scenario_id or BASELINE_SCENARIO_ID)

        season_dir = self._season_dir(season)
        if not season_dir.exists():
            return ScenarioOverlay.empty(season, scenario_id)

        candidates = [season_dir / f"{scenario_id}.json"]
        # Allow alternative naming with suffix .scenario.json
        candidates.append(season_dir / f"{scenario_id}.scenario.json")

        for path in candidates:
            if path.exists():
                try:
                    raw = json.loads(path.read_text())
                except json.JSONDecodeError:
                    break
                break
        else:
            return ScenarioOverlay.empty(season, scenario_id)

        if "scenario_id" not in raw:
            raw["scenario_id"] = scenario_id
        if "season" not in raw:
            raw["season"] = season

        metadata = ScenarioMetadata(
            scenario_id=str(raw.get("scenario_id", scenario_id)),
            season=int(raw.get("season", season)),
            label=raw.get("label") if isinstance(raw.get("label"), str) else None,
            description=raw.get("description") if isinstance(raw.get("description"), str) else None,
            path=path,
            updated_at=raw.get("updated_at") if isinstance(raw.get("updated_at"), str) else None,
            is_default=bool(raw.get("is_default", False)),
        )

        completed_overrides: Dict[int, CompletedWeekOverride] = {}
        completed_payload = raw.get("completed_weeks") or {}
        if isinstance(completed_payload, dict):
            for week_raw, week_payload in completed_payload.items():
                week = _coerce_int(week_raw)
                if week is None or not isinstance(week_payload, dict):
                    continue
                completed_overrides[week] = CompletedWeekOverride.from_dict(week, week_payload)

        projection_overrides: Dict[int, ProjectionWeekOverride] = {}
        projection_payload = raw.get("projection_weeks") or raw.get("projections") or {}
        if isinstance(projection_payload, dict):
            for week_raw, week_payload in projection_payload.items():
                week = _coerce_int(week_raw)
                if week is None or not isinstance(week_payload, dict):
                    continue
                projection_overrides[week] = ProjectionWeekOverride.from_dict(week, week_payload)

        return ScenarioOverlay(
            metadata=metadata,
            completed_weeks=completed_overrides,
            projection_weeks=projection_overrides,
        )
