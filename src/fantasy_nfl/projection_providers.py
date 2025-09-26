from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Sequence

import pandas as pd

from .espn import EspnClient
from .merge import ESPN_STAT_CODE_MAP
from .normalize import LINEUP_SLOT_NAMES, POSITION_NAMES
from .projection_baseline import ProjectionBaselineBuilder
from .settings import AppSettings


PROVIDER_ESPN = "espn"
PROVIDER_USAGE = "usage"


def _load_m_roster(settings: AppSettings, season: int, week: int) -> dict:
    season_dir = settings.data_root / "raw" / "espn" / str(season)
    season_dir.mkdir(parents=True, exist_ok=True)
    path = season_dir / f"view-mRoster-week-{week}.json"

    if path.exists():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            pass  # fall back to refetch

    original_season = settings.espn_season
    settings.espn_season = season
    try:
        with EspnClient(settings) as client:
            data = client.fetch_view("mRoster", params={"scoringPeriodId": week})
            client.save_view("mRoster", data, suffix=f"week-{week}")
    finally:
        settings.espn_season = original_season

    return json.loads(path.read_text())


def _espn_projection_rows(raw: dict, season: int, week: int) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    teams = raw.get("teams", []) or []
    for team in teams:
        team_id = team.get("id")
        roster = team.get("roster", {})
        entries = roster.get("entries", []) if isinstance(roster, dict) else []
        for entry in entries:
            player_entry = entry.get("playerPoolEntry", {})
            player = player_entry.get("player", {})
            espn_player_id = player.get("id")
            if espn_player_id is None:
                continue

            stats = player.get("stats", []) or []
            projection = next(
                (
                    stat
                    for stat in stats
                    if stat.get("statSourceId") == 1
                    and stat.get("scoringPeriodId") == week
                    and stat.get("statSplitTypeId") in (0, 1)
                ),
                None,
            )
            if projection is None:
                continue

            stat_map = projection.get("stats", {}) or {}

            position_id = player.get("defaultPositionId")
            row: dict[str, object] = {
                "season": season,
                "week": week,
                "team_id": team_id,
                "espn_player_id": espn_player_id,
                "player_name": player.get("fullName") or player.get("lastName") or "",
                "espn_position": POSITION_NAMES.get(position_id, str(position_id) if position_id is not None else ""),
            }

            lineup_slot_id = entry.get("lineupSlotId")
            row["lineup_slot"] = LINEUP_SLOT_NAMES.get(lineup_slot_id, str(lineup_slot_id) if lineup_slot_id is not None else "")

            for stat_name, code in ESPN_STAT_CODE_MAP.items():
                value = stat_map.get(str(code))
                if value is None:
                    value = stat_map.get(code)
                row[stat_name] = float(value) if value is not None else 0.0

            rows.append(row)

    return rows


@dataclass
class ProjectionProviderResult:
    dataframe: pd.DataFrame


class ProjectionProvider:
    name: str

    def load_week(self, season: int, week: int) -> ProjectionProviderResult:
        raise NotImplementedError


class EspnProjectionProvider(ProjectionProvider):
    name = PROVIDER_ESPN

    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings

    def load_week(self, season: int, week: int) -> ProjectionProviderResult:
        raw = _load_m_roster(self.settings, season, week)
        rows = _espn_projection_rows(raw, season, week)
        if not rows:
            return ProjectionProviderResult(pd.DataFrame(columns=["season", "week", "espn_player_id"]))

        df = pd.DataFrame(rows)
        df["season"] = season
        df["week"] = week
        df["espn_position"] = df.get("espn_position", "").astype(str).str.upper()
        df["lineup_slot"] = df.get("lineup_slot", "").astype(str).str.upper()
        return ProjectionProviderResult(df)


class UsageProjectionProvider(ProjectionProvider):
    name = PROVIDER_USAGE

    def __init__(self, settings: AppSettings, lookback_weeks: int) -> None:
        self.builder = ProjectionBaselineBuilder(settings, lookback_weeks=lookback_weeks)

    def load_week(self, season: int, week: int) -> ProjectionProviderResult:
        df = self.builder.build_week(season, week, output_path=None)
        return ProjectionProviderResult(df)


def combine_providers(dataframes: Sequence[pd.DataFrame]) -> pd.DataFrame:
    base: pd.DataFrame | None = None
    key_fields = ["season", "week", "espn_player_id"]
    for df in dataframes:
        if df is None or df.empty:
            continue
        if base is None:
            base = df.copy()
            continue

        append_candidates = df[[col for col in df.columns]].copy()
        base_keys = set(zip(base[key_fields[0]], base[key_fields[1]], base[key_fields[2]]))
        to_append_rows = []
        for _, row in append_candidates.iterrows():
            key = (row[key_fields[0]], row[key_fields[1]], row[key_fields[2]])
            if key in base_keys:
                continue
            to_append_rows.append(row)
            base_keys.add(key)
        if to_append_rows:
            base = pd.concat([base, pd.DataFrame(to_append_rows)], ignore_index=True)

    if base is None:
        return pd.DataFrame(columns=["season", "week", "espn_player_id"])

    base["espn_position"] = base.get("espn_position", "").astype(str).str.upper()
    base["lineup_slot"] = base.get("lineup_slot", "").astype(str).str.upper()
    return base


def build_projection_baseline(
    settings: AppSettings,
    season: int,
    week: int,
    providers: Iterable[str],
    lookback_weeks: int,
) -> pd.DataFrame:
    provider_results: List[pd.DataFrame] = []

    provider_map = {}
    for name in providers:
        normalized = name.strip().lower()
        if normalized == PROVIDER_ESPN:
            provider_map[normalized] = EspnProjectionProvider(settings)
        elif normalized == PROVIDER_USAGE:
            provider_map[normalized] = UsageProjectionProvider(settings, lookback_weeks)
        else:
            raise ValueError(f"Unknown projection provider '{name}'")

    for name in providers:
        provider = provider_map[name.strip().lower()]
        result = provider.load_week(season, week)
        provider_results.append(result.dataframe)

    combined = combine_providers(provider_results)
    if "season" not in combined.columns or combined["season"].isna().any():
        combined["season"] = combined.get("season", pd.Series([], dtype="float")).fillna(season)
    if "week" not in combined.columns:
        combined["week"] = week

    return combined
