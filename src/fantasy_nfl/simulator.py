from __future__ import annotations

import json
import math
import random
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd

from .normalize import LINEUP_SLOT_NAMES, POSITION_NAMES
from .overlays import BASELINE_SCENARIO_ID, OverlayStore, ScenarioOverlay
from .settings import AppSettings


DEFAULT_SIGMA = 18.0  # point spread standard deviation assumption for win probabilities
DEFAULT_SIMULATIONS = 500
DEFAULT_PLAYOFF_SLOTS = 4

NON_SCORING_LINEUP_SLOT_IDS = {20, 21, 24, 25, 26, 27}


@dataclass
class TeamMeta:
    team_id: int
    name: str
    abbrev: Optional[str]
    owners: list[str]
    logo_url: Optional[str]


@dataclass
class TeamProjection:
    team: TeamMeta
    projected_points: float
    starters: list[dict[str, object]]
    bench: list[dict[str, object]]


@dataclass
class MatchupProjection:
    week: int
    matchup_id: str
    home: TeamProjection
    away: TeamProjection
    home_win_probability: float
    away_win_probability: float

    @property
    def favorite_team_id(self) -> Optional[int]:
        if self.home_win_probability > self.away_win_probability:
            return self.home.team.team_id
        if self.away_win_probability > self.home_win_probability:
            return self.away.team.team_id
        return None

    @property
    def projected_margin(self) -> float:
        return self.home.projected_points - self.away.projected_points


class RestOfSeasonSimulator:
    """Builds a deterministic rest-of-season projection grid from existing artifacts."""

    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self.overlay_store = OverlayStore(settings.data_root)
        self._active_overlay: Optional[ScenarioOverlay] = None
        self._active_scenario_id: str = BASELINE_SCENARIO_ID

    # ---------------------------
    # Data loading helpers
    # ---------------------------

    def _load_week_scores(self, season: int, week: int) -> pd.DataFrame:
        scores_path = (
            self.settings.data_root
            / "out"
            / "espn"
            / str(season)
            / f"weekly_scores_{season}_week_{week}.csv"
        )
        if scores_path.exists():
            df = pd.read_csv(scores_path)
            if "counts_for_score" in df.columns:
                df["counts_for_score"] = (
                    df["counts_for_score"].astype(str).str.lower().isin(["true", "1", "yes"])
                )
            else:
                df["counts_for_score"] = True
            df["team_id"] = pd.to_numeric(df.get("team_id"), errors="coerce").astype("Int64")
            df["score_total"] = pd.to_numeric(df.get("score_total"), errors="coerce").fillna(0.0)
        else:
            df = pd.DataFrame(
                columns=[
                    "team_id",
                    "espn_player_id",
                    "player_name",
                    "lineup_slot",
                    "espn_position",
                    "score_total",
                    "counts_for_score",
                ]
            )

        scoreboard_df = self._load_scoreboard_player_points(season, week)
        if not scoreboard_df.empty:
            df = scoreboard_df

        return self._apply_completed_week_overrides(df, week)

    def _summarize_team_points(
        self,
        teams: dict[int, TeamMeta],
        table: pd.DataFrame,
        points_column: str,
    ) -> dict[int, TeamProjection]:
        team_projections: dict[int, TeamProjection] = {}

        normalized = table.copy()
        normalized[points_column] = pd.to_numeric(
            normalized.get(points_column), errors="coerce"
        ).fillna(0.0)

        if "counts_for_score" in normalized.columns:
            normalized["counts_for_score"] = normalized["counts_for_score"].astype(bool)
        else:
            normalized["counts_for_score"] = False

        for team_id in normalized["team_id"].dropna().unique():
            team_id_int = int(team_id)
            if team_id_int not in teams:
                continue

            team_rows = normalized.loc[normalized["team_id"] == team_id]
            starters: list[dict[str, object]] = []
            bench: list[dict[str, object]] = []
            total_points = 0.0

            for _, row in team_rows.iterrows():
                points = float(row.get(points_column, 0.0))
                entry = {
                    "espn_player_id": int(row.get("espn_player_id")) if pd.notna(row.get("espn_player_id")) else None,
                    "player_name": str(row.get("player_name", "")),
                    "lineup_slot": str(row.get("lineup_slot", "")),
                    "espn_position": str(row.get("espn_position", "")),
                    "projected_points": round(points, 2),
                    "counts_for_score": bool(row.get("counts_for_score", False)),
                }
                if entry["counts_for_score"]:
                    starters.append(entry)
                    total_points += points
                else:
                    bench.append(entry)

            starters.sort(key=lambda item: item["projected_points"], reverse=True)
            bench.sort(key=lambda item: item["projected_points"], reverse=True)

            team_projections[team_id_int] = TeamProjection(
                team=teams[team_id_int],
                projected_points=round(total_points, 2),
                starters=starters,
                bench=bench,
            )

        return team_projections

    def _summarize_team_projections(
        self,
        teams: dict[int, TeamMeta],
        projections: pd.DataFrame,
    ) -> dict[int, TeamProjection]:
        return self._summarize_team_points(teams, projections, "projected_points")

    def _summarize_team_actuals(
        self,
        teams: dict[int, TeamMeta],
        scores: pd.DataFrame,
    ) -> dict[int, TeamProjection]:
        return self._summarize_team_points(teams, scores, "score_total")

    def _load_matchup_results(self, season: int) -> dict[tuple[int, str], dict[str, object]]:
        raw_path = (
            self.settings.data_root
            / "raw"
            / "espn"
            / str(season)
            / "view-mMatchup.json"
        )
        if not raw_path.exists():
            return {}

        try:
            data = json.loads(raw_path.read_text())
        except json.JSONDecodeError:
            return {}

        results: dict[tuple[int, str], dict[str, object]] = {}
        for matchup in data.get("schedule", []):
            week = matchup.get("matchupPeriodId")
            matchup_id = matchup.get("id")
            home = matchup.get("home", {})
            away = matchup.get("away", {})
            home_team_id = home.get("teamId")
            away_team_id = away.get("teamId")
            if week is None or matchup_id is None or home_team_id is None or away_team_id is None:
                continue

            key = (int(week), str(matchup_id))
            results[key] = {
                "home_team_id": int(home_team_id),
                "away_team_id": int(away_team_id),
                "home_points": float(home.get("totalPoints") or 0.0),
                "away_points": float(away.get("totalPoints") or 0.0),
                "winner": matchup.get("winner"),
            }

        results_with_live = self._apply_live_score_overrides(season, results)
        return self._apply_matchup_overrides(results_with_live)

    def _apply_live_score_overrides(
        self,
        season: int,
        results: dict[tuple[int, str], dict[str, object]],
    ) -> dict[tuple[int, str], dict[str, object]]:
        if not results:
            return results

        scoreboard_entries = self._load_scoreboard_live_entries(season)
        roster_totals_by_week = self._load_roster_live_totals(season)

        if not scoreboard_entries and not roster_totals_by_week:
            return results

        enriched = {key: dict(value) for key, value in results.items()}
        for (week, matchup_id), payload in enriched.items():
            home_team_id = payload.get("home_team_id")
            away_team_id = payload.get("away_team_id")
            winner_raw = str(payload.get("winner") or "").upper()

            scoreboard_entry = scoreboard_entries.get((week, matchup_id))
            week_totals = roster_totals_by_week.get(week)

            if scoreboard_entry:
                home_live = scoreboard_entry.get("home_points")
                away_live = scoreboard_entry.get("away_points")
            else:
                home_live = week_totals.get(int(home_team_id)) if week_totals and home_team_id is not None else None
                away_live = week_totals.get(int(away_team_id)) if week_totals and away_team_id is not None else None

            if home_live is not None:
                existing = float(payload.get("home_points", 0.0) or 0.0)
                if existing <= 0.0 or winner_raw not in {"HOME", "AWAY", "TIE"}:
                    payload["home_points"] = round(float(home_live), 2)

            if away_live is not None:
                existing = float(payload.get("away_points", 0.0) or 0.0)
                if existing <= 0.0 or winner_raw not in {"HOME", "AWAY", "TIE"}:
                    payload["away_points"] = round(float(away_live), 2)

            if winner_raw in {"HOME", "AWAY", "TIE"}:
                payload.setdefault("status", "final")
            elif scoreboard_entry and scoreboard_entry.get("status"):
                payload["status"] = scoreboard_entry["status"]
            elif week_totals or scoreboard_entry:
                payload["status"] = "in_progress"

        return enriched

    def _load_scoreboard_live_entries(self, season: int) -> dict[tuple[int, str], dict[str, object]]:
        scoreboard_dir = self.settings.data_root / "raw" / "espn" / str(season)
        if not scoreboard_dir.exists():
            return {}

        entries: dict[tuple[int, str], dict[str, object]] = {}
        for file in scoreboard_dir.iterdir():
            if not file.is_file():
                continue
            name = file.name
            if not name.startswith("view-mScoreboard-week-") or not name.endswith(".json"):
                continue
            try:
                week = int(name.split("view-mScoreboard-week-")[1].split(".json")[0])
            except (IndexError, ValueError):
                continue

            try:
                data = json.loads(file.read_text())
            except json.JSONDecodeError:
                continue

            schedule = data.get("schedule")
            if not isinstance(schedule, list):
                continue

            for matchup in schedule:
                matchup_id = matchup.get("id")
                if matchup_id is None:
                    continue

                matchup_week = matchup.get("matchupPeriodId")
                try:
                    matchup_week_int = int(matchup_week)
                except (TypeError, ValueError):
                    matchup_week_int = week
                if matchup_week_int != week:
                    continue

                home_payload = matchup.get("home") or {}
                away_payload = matchup.get("away") or {}

                def _extract_points(payload: dict[str, object]) -> float | None:
                    for key in ("totalPointsLive", "totalPoints", "adjustedPoints", "totalProjectedPoints"):
                        raw = payload.get(key)
                        if raw is None:
                            continue
                        try:
                            return float(raw)
                        except (TypeError, ValueError):
                            continue
                    return None

                status_value: Optional[str] = None
                status_payload = matchup.get("status")
                if isinstance(status_payload, dict):
                    type_info = status_payload.get("type")
                    if isinstance(type_info, dict):
                        name = str(type_info.get("name") or "").upper()
                    else:
                        name = str(type_info or "").upper()
                    if "FINAL" in name:
                        status_value = "final"
                    elif "IN_PROGRESS" in name or "LIVE" in name:
                        status_value = "in_progress"
                if not status_value:
                    name = str(status_payload.get("name") if isinstance(status_payload, dict) else "").upper()
                    if "FINAL" in name:
                        status_value = "final"
                    elif "IN_PROGRESS" in name or "LIVE" in name:
                        status_value = "in_progress"

                if not status_value:
                    status_value = "in_progress"

                entries[(week, str(matchup_id))] = {
                    "status": status_value,
                    "home_team_id": home_payload.get("teamId"),
                    "away_team_id": away_payload.get("teamId"),
                    "home_points": _extract_points(home_payload),
                    "away_points": _extract_points(away_payload),
                }

        return entries

    def _load_scoreboard_player_points(self, season: int, week: int) -> pd.DataFrame:
        scoreboard_path = (
            self.settings.data_root
            / "raw"
            / "espn"
            / str(season)
            / f"view-mScoreboard-week-{week}.json"
        )
        if not scoreboard_path.exists():
            return pd.DataFrame(
                columns=[
                    "team_id",
                    "espn_player_id",
                    "player_name",
                    "lineup_slot",
                    "espn_position",
                    "score_total",
                    "counts_for_score",
                ]
            )

        try:
            data = json.loads(scoreboard_path.read_text())
        except json.JSONDecodeError:
            return pd.DataFrame(columns=[
                "team_id",
                "espn_player_id",
                "player_name",
                "lineup_slot",
                "espn_position",
                "score_total",
                "counts_for_score",
            ])

        rows: list[dict[str, object]] = []
        schedule = data.get("schedule")
        if not isinstance(schedule, list):
            return pd.DataFrame(columns=[
                "team_id",
                "espn_player_id",
                "player_name",
                "lineup_slot",
                "espn_position",
                "score_total",
                "counts_for_score",
            ])

        roster_entries = self._load_roster_slot_map(season, week)
        seen_players: set[tuple[int, int]] = set()

        for matchup in schedule:
            matchup_week = matchup.get("matchupPeriodId")
            if matchup_week is not None and matchup_week != week:
                continue

            for side in ("home", "away"):
                team_payload = matchup.get(side) or {}
                team_id = team_payload.get("teamId")
                if team_id is None:
                    continue

                roster_payload = team_payload.get("rosterForMatchupPeriod") or {}
                entries = roster_payload.get("entries", []) or []
                for entry in entries:
                    slot_id = entry.get("lineupSlotId")
                    pool_entry = entry.get("playerPoolEntry") or {}
                    player = pool_entry.get("player") or {}

                    espn_player_id = pool_entry.get("id") or player.get("id")
                    player_name = player.get("fullName") or player.get("lastName") or "Unknown"
                    slot_id, counts_for_score, position_id, name_from_roster = roster_entries.get(
                        (int(team_id), int(espn_player_id) if espn_player_id is not None else None),
                        (slot_id, None, player.get("defaultPositionId"), player_name),
                    )
                    lineup_slot = LINEUP_SLOT_NAMES.get(slot_id, str(slot_id) if slot_id is not None else "")
                    position_name = POSITION_NAMES.get(position_id, str(position_id) if position_id is not None else "")

                    raw_points = pool_entry.get("appliedStatTotal")
                    if raw_points is None:
                        raw_points = entry.get("totalPointsLive") or entry.get("totalPoints") or 0.0

                    if counts_for_score is None:
                        counts_for_score = slot_id not in NON_SCORING_LINEUP_SLOT_IDS if slot_id is not None else True

                    rows.append(
                        {
                            "team_id": int(team_id),
                            "espn_player_id": int(espn_player_id) if espn_player_id is not None else None,
                            "player_name": name_from_roster or player_name,
                            "lineup_slot": lineup_slot,
                            "espn_position": position_name or "",
                            "score_total": round(float(raw_points), 2),
                            "counts_for_score": counts_for_score,
                        }
                    )
                    if espn_player_id is not None:
                        seen_players.add((int(team_id), int(espn_player_id)))

        # Include remaining rostered players (bench) with zero totals for display consistency
        for (team_id, player_id), (slot_id, counts_for_score, position_id, player_name) in roster_entries.items():
            if player_id is None or (team_id, player_id) in seen_players:
                continue
            lineup_slot = LINEUP_SLOT_NAMES.get(slot_id, str(slot_id) if slot_id is not None else "")
            position_name = POSITION_NAMES.get(position_id, str(position_id) if position_id is not None else "")
            rows.append(
                {
                    "team_id": team_id,
                    "espn_player_id": player_id,
                    "player_name": player_name,
                    "lineup_slot": lineup_slot,
                    "espn_position": position_name or "",
                    "score_total": 0.0,
                    "counts_for_score": counts_for_score if counts_for_score is not None else slot_id not in NON_SCORING_LINEUP_SLOT_IDS,
                }
            )

        if not rows:
            return pd.DataFrame(
                columns=[
                    "team_id",
                    "espn_player_id",
                    "player_name",
                    "lineup_slot",
                    "espn_position",
                    "score_total",
                    "counts_for_score",
                ]
            )

        return pd.DataFrame(rows)

    def _load_roster_slot_map(
        self,
        season: int,
        week: int,
    ) -> dict[tuple[int, int], tuple[int | None, Optional[bool], Optional[int], str]]:
        roster_path = (
            self.settings.data_root
            / "raw"
            / "espn"
            / str(season)
            / f"view-mRoster-week-{week}.json"
        )
        mapping: dict[tuple[int, int], tuple[int | None, Optional[bool], Optional[int], str]] = {}
        if not roster_path.exists():
            return mapping

        try:
            data = json.loads(roster_path.read_text())
        except json.JSONDecodeError:
            return mapping

        for team in data.get("teams", []):
            team_id = team.get("id")
            if team_id is None:
                continue

            roster = team.get("roster", {})
            for entry in roster.get("entries", []) or []:
                slot_id = entry.get("lineupSlotId")
                pool_entry = entry.get("playerPoolEntry") or {}
                player = pool_entry.get("player") or {}
                player_id = pool_entry.get("id") or player.get("id")
                if player_id is None:
                    continue

                counts_for_score = slot_id not in NON_SCORING_LINEUP_SLOT_IDS if slot_id is not None else True
                position_id = player.get("defaultPositionId")
                player_name = player.get("fullName") or player.get("lastName") or "Unknown"

                mapping[(int(team_id), int(player_id))] = (slot_id, counts_for_score, position_id, player_name)

        return mapping

    def _load_roster_live_totals(self, season: int) -> dict[int, dict[int, float]]:
        roster_dir = self.settings.data_root / "raw" / "espn" / str(season)
        if not roster_dir.exists():
            return {}

        totals_by_week: dict[int, dict[int, float]] = {}
        for entry in roster_dir.iterdir():
            if not entry.is_file() or not entry.name.startswith("view-mRoster-week-") or not entry.name.endswith(".json"):
                continue
            try:
                week = int(entry.name.split("view-mRoster-week-")[1].split(".json")[0])
            except (IndexError, ValueError):
                continue

            totals = self._extract_roster_live_totals(entry)
            if totals:
                totals_by_week[week] = totals

        return totals_by_week

    def _extract_roster_live_totals(self, path: Path) -> dict[int, float]:
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError:
            return {}

        scoring_period = data.get("scoringPeriodId")
        totals: dict[int, float] = {}

        for team in data.get("teams", []):
            team_id = team.get("id")
            if team_id is None:
                continue

            total_points = 0.0
            roster = team.get("roster", {})
            entries = roster.get("entries", []) or []

            for entry in entries:
                slot_id = entry.get("lineupSlotId")
                if slot_id is None or slot_id in NON_SCORING_LINEUP_SLOT_IDS:
                    continue

                pool_entry = entry.get("playerPoolEntry") or {}
                actual_value: Optional[float] = None

                if scoring_period is not None:
                    for stat in pool_entry.get("player", {}).get("stats", []) or []:
                        if (
                            stat.get("scoringPeriodId") == scoring_period
                            and stat.get("statSourceId") == 1
                            and stat.get("appliedTotal") is not None
                        ):
                            actual_value = float(stat["appliedTotal"])
                            break

                if actual_value is None:
                    applied_total = pool_entry.get("appliedStatTotal")
                    if applied_total is not None:
                        actual_value = float(applied_total)

                if actual_value is None:
                    continue

                total_points += actual_value

            totals[int(team_id)] = round(total_points, 2)

        return totals

    # ---------------------------
    # Public API
    # ---------------------------
    def build_dataset(
        self,
        season: int,
        start_week: Optional[int] = None,
        end_week: Optional[int] = None,
        sigma: float = DEFAULT_SIGMA,
        sim_iterations: int = 0,
        playoff_slots: int = DEFAULT_PLAYOFF_SLOTS,
        random_seed: Optional[int] = None,
        scenario_id: Optional[str] = None,
    ) -> dict[str, object]:
        scenario_key = scenario_id or BASELINE_SCENARIO_ID
        overlay = self.overlay_store.load_overlay(season, scenario_key)
        previous_overlay = self._active_overlay
        previous_scenario_id = self._active_scenario_id
        self._active_overlay = overlay if (overlay.completed_weeks or overlay.projection_weeks) else None
        self._active_scenario_id = overlay.metadata.scenario_id
        try:
            teams = self._load_teams(season)
            if not teams:
                raise FileNotFoundError(
                    f"No teams.csv found for season {season}; run `fantasy espn normalize` first."
                )

            schedule = self._load_schedule(season)
            if schedule.empty:
                raise FileNotFoundError(
                    f"No schedule.csv found for season {season}; run `fantasy espn normalize` first."
                )

            projection_weeks = self._detect_projection_weeks(season)
            if not projection_weeks:
                raise FileNotFoundError(
                    f"No projections found for season {season}; run `fantasy projections baseline` first."
                )

            completed_weeks = self._detect_completed_weeks(season)
            default_start = self._default_start_week(projection_weeks, completed_weeks)
            effective_start = start_week or default_start
            effective_end = end_week or max(projection_weeks)

            if effective_start > effective_end:
                raise ValueError("start_week must be <= end_week")

            weeks_to_process = [wk for wk in projection_weeks if effective_start <= wk <= effective_end]
            if not weeks_to_process:
                raise ValueError(
                    f"No projection files fall within weeks {effective_start}-{effective_end}."
                )

            matchup_rows: list[MatchupProjection] = []
            actual_matchups_by_week: dict[int, list[dict[str, object]]] = defaultdict(list)
            future_matchups_by_week: dict[int, list[MatchupProjection]] = defaultdict(list)
            team_schedule: dict[int, list[dict[str, object]]] = {team_id: [] for team_id in teams}
            standings_tracker = {
                team_id: {"wins": 0.0, "losses": 0.0, "ties": 0.0, "points": 0.0}
                for team_id in teams
            }

            history_weeks = [wk for wk in completed_weeks if wk < effective_start]
            matchup_results = self._load_matchup_results(season)

            for week in history_weeks:
                scores_df = self._load_week_scores(season, week)
                if scores_df.empty:
                    continue

                team_actuals = self._summarize_team_actuals(teams, scores_df)
                week_schedule = schedule.loc[schedule["week"] == week]

                for _, matchup in week_schedule.iterrows():
                    home_team_id = int(matchup["home_team_id"])
                    away_team_id = int(matchup["away_team_id"])
                    matchup_id = str(matchup["matchup_id"])

                    actual = matchup_results.get((week, matchup_id))
                    home_proj = team_actuals.get(home_team_id)
                    away_proj = team_actuals.get(away_team_id)

                    if actual is None or home_proj is None or away_proj is None:
                        continue

                    home_points = float(actual.get("home_points", home_proj.projected_points))
                    away_points = float(actual.get("away_points", away_proj.projected_points))
                    winner = actual.get("winner")
                    margin = home_points - away_points

                    status_raw = str(actual.get("status") or "").lower()
                    winner_upper = str(winner or "").upper()

                    if status_raw not in {"final", "in_progress"}:
                        if winner_upper in {"HOME", "AWAY", "TIE"}:
                            status_raw = "final"
                        elif abs(margin) > 1e-6 or home_points > 0 or away_points > 0:
                            status_raw = "in_progress"
                        else:
                            status_raw = "scheduled"

                    is_final = status_raw == "final"

                    if is_final:
                        if winner_upper == "HOME":
                            home_prob_final, away_prob_final = 1.0, 0.0
                            home_result, away_result = "win", "loss"
                        elif winner_upper == "AWAY":
                            home_prob_final, away_prob_final = 0.0, 1.0
                            home_result, away_result = "loss", "win"
                        elif winner_upper == "TIE":
                            home_prob_final = away_prob_final = 0.5
                            home_result = away_result = "tie"
                        elif margin > 1e-6:
                            home_prob_final, away_prob_final = 1.0, 0.0
                            home_result, away_result = "win", "loss"
                        elif margin < -1e-6:
                            home_prob_final, away_prob_final = 0.0, 1.0
                            home_result, away_result = "loss", "win"
                        else:
                            home_prob_final = away_prob_final = 0.5
                            home_result = away_result = "tie"
                    else:
                        home_prob_final = away_prob_final = 0.5
                        home_result = away_result = None

                    home_proj.projected_points = round(home_points, 2)
                    away_proj.projected_points = round(away_points, 2)

                    if is_final:
                        standings_tracker[home_team_id]["points"] += home_points
                        standings_tracker[away_team_id]["points"] += away_points

                        if home_result == "win":
                            standings_tracker[home_team_id]["wins"] += 1
                            standings_tracker[away_team_id]["losses"] += 1
                        elif home_result == "loss":
                            standings_tracker[home_team_id]["losses"] += 1
                            standings_tracker[away_team_id]["wins"] += 1
                        else:
                            standings_tracker[home_team_id]["ties"] += 1
                            standings_tracker[away_team_id]["ties"] += 1

                    team_schedule[home_team_id].append(
                        {
                            "week": week,
                            "matchup_id": matchup_id,
                            "opponent_team_id": away_team_id,
                            "is_home": True,
                            "projected_points": home_points,
                            "opponent_projected_points": away_points,
                            "win_probability": home_prob_final,
                            "projected_margin": margin,
                            "is_actual": True,
                            "result": home_result,
                            "status": status_raw,
                            "actual_points": home_points,
                            "opponent_actual_points": away_points,
                        }
                    )
                    team_schedule[away_team_id].append(
                        {
                            "week": week,
                            "matchup_id": matchup_id,
                            "opponent_team_id": home_team_id,
                            "is_home": False,
                            "projected_points": away_points,
                            "opponent_projected_points": home_points,
                            "win_probability": away_prob_final,
                            "projected_margin": -margin,
                            "is_actual": True,
                            "result": away_result,
                            "status": status_raw,
                            "actual_points": away_points,
                            "opponent_actual_points": home_points,
                        }
                    )

                    matchup_proj = MatchupProjection(
                        week=week,
                        matchup_id=matchup_id,
                        home=home_proj,
                        away=away_proj,
                        home_win_probability=home_prob_final,
                        away_win_probability=away_prob_final,
                    )
                    matchup_dict = self._matchup_to_dict(matchup_proj)
                    matchup_dict["is_actual"] = True
                    matchup_dict["status"] = status_raw
                    matchup_dict["result"] = {
                        "home": home_result,
                        "away": away_result,
                    }
                    matchup_dict["final_score"] = {
                        "home": round(home_points, 2),
                        "away": round(away_points, 2),
                    }
                    actual_matchups_by_week[week].append(matchup_dict)

            base_records = {
                team_id: {
                    "wins": standings_tracker[team_id]["wins"],
                    "losses": standings_tracker[team_id]["losses"],
                    "points": standings_tracker[team_id]["points"],
                }
                for team_id in teams
            }

            for week in weeks_to_process:
                projections = self._load_week_projection(season, week)
                if projections.empty:
                    continue

                team_projections = self._summarize_team_projections(teams, projections)
                week_schedule = schedule.loc[schedule["week"] == week]

                for _, matchup in week_schedule.iterrows():
                    home_team_id = int(matchup["home_team_id"])
                    away_team_id = int(matchup["away_team_id"])
                    matchup_id = str(matchup["matchup_id"])

                    home_proj = team_projections.get(home_team_id)
                    away_proj = team_projections.get(away_team_id)

                    if home_proj is None or away_proj is None:
                        continue

                    home_prob, away_prob = self._estimate_win_probabilities(
                        home_proj.projected_points, away_proj.projected_points, sigma
                    )

                    matchup_proj = MatchupProjection(
                        week=week,
                        matchup_id=matchup_id,
                        home=home_proj,
                        away=away_proj,
                        home_win_probability=home_prob,
                        away_win_probability=away_prob,
                    )
                    matchup_rows.append(matchup_proj)
                    future_matchups_by_week[week].append(matchup_proj)

                    standings_tracker[home_team_id]["wins"] += home_prob
                    standings_tracker[home_team_id]["losses"] += away_prob
                    standings_tracker[home_team_id]["points"] += home_proj.projected_points
                    if abs(home_prob - away_prob) < 1e-6:
                        standings_tracker[home_team_id]["ties"] += 1.0

                    standings_tracker[away_team_id]["wins"] += away_prob
                    standings_tracker[away_team_id]["losses"] += home_prob
                    standings_tracker[away_team_id]["points"] += away_proj.projected_points
                    if abs(home_prob - away_prob) < 1e-6:
                        standings_tracker[away_team_id]["ties"] += 1.0

                    delta = home_proj.projected_points - away_proj.projected_points

                    team_schedule[home_team_id].append(
                        {
                            "week": week,
                            "matchup_id": matchup_id,
                            "opponent_team_id": away_team_id,
                            "is_home": True,
                            "projected_points": home_proj.projected_points,
                            "opponent_projected_points": away_proj.projected_points,
                            "win_probability": home_prob,
                            "projected_margin": delta,
                            "is_actual": False,
                        }
                    )
                    team_schedule[away_team_id].append(
                        {
                            "week": week,
                            "matchup_id": matchup_id,
                            "opponent_team_id": home_team_id,
                            "is_home": False,
                            "projected_points": away_proj.projected_points,
                            "opponent_projected_points": home_proj.projected_points,
                            "win_probability": away_prob,
                            "projected_margin": -delta,
                            "is_actual": False,
                        }
                    )

            matchup_rows.sort(key=lambda item: (item.week, item.matchup_id))

            for schedule_entries in team_schedule.values():
                schedule_entries.sort(key=lambda item: item["week"])

            future_games_per_team = {
                team_id: sum(1 for entry in entries if not entry.get("is_actual", False))
                for team_id, entries in team_schedule.items()
            }

            standings = []
            for team_id, record in standings_tracker.items():
                projected_games = record["wins"] + record["losses"]
                avg_points = record["points"] / projected_games if projected_games else 0.0
                standings.append(
                    {
                        "team": self._team_to_dict(teams[team_id]),
                        "projected_record": {
                            "wins": round(record["wins"], 3),
                            "losses": round(record["losses"], 3),
                            "ties": round(record["ties"], 3),
                        },
                        "projected_points": round(record["points"], 2),
                        "average_projected_points": round(avg_points, 2),
                        "games_remaining": future_games_per_team.get(team_id, 0),
                    }
                )

            standings.sort(key=lambda entry: (-entry["projected_record"]["wins"], -entry["projected_points"]))

            weeks_payload: list[dict[str, object]] = []
            all_weeks = sorted(set(history_weeks) | set(weeks_to_process))
            for week in all_weeks:
                if week in actual_matchups_by_week:
                    weeks_payload.append(
                        {
                            "week": week,
                            "matchups": actual_matchups_by_week[week],
                        }
                    )
                else:
                    future_dicts = []
                    for matchup in future_matchups_by_week.get(week, []):
                        matchup_dict = self._matchup_to_dict(matchup)
                        matchup_dict["is_actual"] = False
                        future_dicts.append(matchup_dict)
                    if future_dicts:
                        weeks_payload.append(
                            {
                                "week": week,
                                "matchups": future_dicts,
                            }
                        )

            dataset: dict[str, object] = {
                "season": season,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "start_week": min(weeks_to_process),
                "end_week": max(weeks_to_process),
                "projection_sigma": sigma,
                "teams": [self._team_to_dict(team) for team in teams.values()],
                "team_schedule": {str(team_id): schedule for team_id, schedule in team_schedule.items()},
                "weeks": weeks_payload,
                "standings": standings,
                "sources": {
                    "projections_weeks": weeks_to_process,
                    "completed_weeks": history_weeks,
                },
                "completed_weeks": history_weeks,
            }

            if sim_iterations > 0:
                monte_carlo = self._run_monte_carlo(
                    matchups=matchup_rows,
                    teams=teams,
                    team_schedule=team_schedule,
                    iterations=sim_iterations,
                    playoff_slots=playoff_slots,
                    random_seed=random_seed,
                    base_records=base_records,
                    future_games=future_games_per_team,
                )
                dataset["monte_carlo"] = monte_carlo

            scenario_summary = {
                "id": overlay.metadata.scenario_id,
                "label": overlay.metadata.label
                or (
                    "Baseline"
                    if overlay.metadata.scenario_id == BASELINE_SCENARIO_ID
                    else overlay.metadata.scenario_id
                ),
                "season": overlay.metadata.season,
                "is_baseline": overlay.metadata.scenario_id == BASELINE_SCENARIO_ID,
                "overrides": {
                    "completed_weeks": sorted(overlay.completed_weeks.keys()),
                    "projection_weeks": sorted(overlay.projection_weeks.keys()),
                },
            }
            if overlay.metadata.description:
                scenario_summary["description"] = overlay.metadata.description
            if overlay.metadata.updated_at:
                scenario_summary["updated_at"] = overlay.metadata.updated_at
            dataset["scenario"] = scenario_summary
            dataset["sources"]["scenario_id"] = overlay.metadata.scenario_id

            return dataset
        finally:
            self._active_overlay = previous_overlay
            self._active_scenario_id = previous_scenario_id

    def write_dataset(
        self,
        dataset: dict[str, object],
        output_path: Path,
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        # Ensure all values are JSON-serializable by converting via json dumps/loads roundtrip
        serialized = json.dumps(dataset, indent=2)
        output_path.write_text(serialized)
        return output_path

    # ---------------------------
    # Internal helpers
    # ---------------------------
    def _load_teams(self, season: int) -> dict[int, TeamMeta]:
        teams_path = self.settings.data_root / "out" / "espn" / str(season) / "teams.csv"
        if not teams_path.exists():
            return {}

        df = pd.read_csv(teams_path)
        teams: dict[int, TeamMeta] = {}
        for _, row in df.iterrows():
            team_id = int(row["team_id"])
            owners_raw = str(row.get("owners", ""))
            owners = [owner.strip() for owner in owners_raw.split(";") if owner.strip()]
            teams[team_id] = TeamMeta(
                team_id=team_id,
                name=str(row.get("team_name", "Team")),
                abbrev=str(row.get("abbrev")) if pd.notna(row.get("abbrev")) else None,
                owners=owners,
                logo_url=str(row.get("logo")) if pd.notna(row.get("logo")) else None,
            )
        return teams

    def _load_schedule(self, season: int) -> pd.DataFrame:
        schedule_path = self.settings.data_root / "out" / "espn" / str(season) / "schedule.csv"
        if not schedule_path.exists():
            return pd.DataFrame()
        df = pd.read_csv(schedule_path)
        df = df.loc[df["home_team_id"].notna() & df["away_team_id"].notna()].copy()
        df["home_team_id"] = df["home_team_id"].astype(int)
        df["away_team_id"] = df["away_team_id"].astype(int)
        df["week"] = df["week"].astype(int)
        return df

    def _detect_projection_weeks(self, season: int) -> list[int]:
        proj_dir = self.settings.data_root / "out" / "projections" / str(season)
        if not proj_dir.exists():
            return []
        weeks = []
        for entry in proj_dir.iterdir():
            if not entry.is_file():
                continue
            name = entry.name
            if not name.startswith("projected_stats_week_") or not name.endswith(".csv"):
                continue
            try:
                week = int(name.split("projected_stats_week_")[1].split(".csv")[0])
                weeks.append(week)
            except (IndexError, ValueError):
                continue
        return sorted(set(weeks))

    def _detect_completed_weeks(self, season: int) -> list[int]:
        espn_dir = self.settings.data_root / "out" / "espn" / str(season)
        if not espn_dir.exists():
            return []
        weeks = []
        for entry in espn_dir.iterdir():
            if not entry.is_file():
                continue
            name = entry.name
            if not name.startswith(f"weekly_scores_{season}_week_") or not name.endswith(".csv"):
                continue
            try:
                week = int(name.split("weekly_scores_" + str(season) + "_week_")[1].split(".csv")[0])
                weeks.append(week)
            except (IndexError, ValueError):
                continue
        return sorted(set(weeks))

    def _default_start_week(self, projection_weeks: Iterable[int], completed_weeks: Iterable[int]) -> int:
        projection_weeks = sorted(projection_weeks)
        completed_weeks = sorted(completed_weeks)
        if not completed_weeks:
            return projection_weeks[0]
        last_completed = completed_weeks[-1]
        for week in projection_weeks:
            if week > last_completed:
                return week
        return projection_weeks[0]

    def _load_week_projection(self, season: int, week: int) -> pd.DataFrame:
        proj_path = self.settings.data_root / "out" / "projections" / str(season) / f"projected_stats_week_{week}.csv"
        if proj_path.exists():
            df = pd.read_csv(proj_path)
            if "counts_for_score" in df.columns:
                df["counts_for_score"] = df["counts_for_score"].astype(str).str.lower().isin(["true", "1", "yes"])
            else:
                df["counts_for_score"] = False
            df["projected_points"] = pd.to_numeric(df.get("projected_points"), errors="coerce").fillna(0.0)
            df["team_id"] = pd.to_numeric(df.get("team_id"), errors="coerce").astype("Int64")
        else:
            df = pd.DataFrame(
                columns=[
                    "team_id",
                    "espn_player_id",
                    "player_name",
                    "lineup_slot",
                    "espn_position",
                    "projected_points",
                    "counts_for_score",
                ]
            )
        return self._apply_projection_overrides(df, week)

    def _apply_completed_week_overrides(self, df: pd.DataFrame, week: int) -> pd.DataFrame:
        overlay = self._active_overlay
        if overlay is None:
            return df

        week_override = overlay.get_completed_week(week)
        if not week_override:
            return df

        rows = week_override.as_rows()
        if not rows:
            return df

        override_df = pd.DataFrame(rows)

        base_columns = list(df.columns)
        if not base_columns:
            base_columns = [
                "team_id",
                "espn_player_id",
                "player_name",
                "lineup_slot",
                "espn_position",
                "score_total",
                "counts_for_score",
            ]

        for column in base_columns:
            if column not in override_df.columns:
                if column == "counts_for_score":
                    override_df[column] = True
                elif column == "score_total":
                    override_df[column] = 0.0
                else:
                    override_df[column] = pd.NA

        override_df = override_df[base_columns]
        override_df["team_id"] = pd.to_numeric(override_df["team_id"], errors="coerce").astype("Int64")
        override_df["score_total"] = (
            pd.to_numeric(override_df["score_total"], errors="coerce").fillna(0.0)
        )
        override_df["counts_for_score"] = (
            override_df["counts_for_score"].fillna(True).astype(bool)
        )

        if df.empty:
            return override_df

        team_ids = [int(t) for t in override_df["team_id"].dropna().unique()]
        base_df = df.loc[~df["team_id"].isin(team_ids)].copy()
        merged = pd.concat([base_df, override_df], ignore_index=True, sort=False)
        return merged

    def _apply_projection_overrides(self, df: pd.DataFrame, week: int) -> pd.DataFrame:
        overlay = self._active_overlay
        if overlay is None:
            return df

        week_override = overlay.get_projection_week(week)
        if not week_override:
            return df

        rows = week_override.as_rows()
        if not rows:
            return df

        override_df = pd.DataFrame(rows)

        base_columns = list(df.columns)
        if not base_columns:
            base_columns = [
                "team_id",
                "espn_player_id",
                "player_name",
                "lineup_slot",
                "espn_position",
                "projected_points",
                "counts_for_score",
            ]

        for column in base_columns:
            if column not in override_df.columns:
                if column == "counts_for_score":
                    override_df[column] = False
                elif column == "projected_points":
                    override_df[column] = 0.0
                else:
                    override_df[column] = pd.NA

        override_df = override_df[base_columns]
        override_df["team_id"] = pd.to_numeric(override_df["team_id"], errors="coerce").astype("Int64")
        override_df["projected_points"] = (
            pd.to_numeric(override_df["projected_points"], errors="coerce").fillna(0.0)
        )
        override_df["counts_for_score"] = (
            override_df["counts_for_score"].fillna(False).astype(bool)
        )

        if df.empty:
            return override_df

        team_ids = [int(t) for t in override_df["team_id"].dropna().unique()]
        base_df = df.loc[~df["team_id"].isin(team_ids)].copy()
        merged = pd.concat([base_df, override_df], ignore_index=True, sort=False)
        return merged

    def _apply_matchup_overrides(
        self,
        results: dict[tuple[int, str], dict[str, object]],
    ) -> dict[tuple[int, str], dict[str, object]]:
        overlay = self._active_overlay
        if overlay is None:
            return results

        amended = {key: dict(value) for key, value in results.items()}
        for week, week_override in overlay.completed_weeks.items():
            for matchup_id, payload in week_override.matchup_overrides.items():
                key = (week, str(matchup_id))
                current = amended.get(key, {}).copy()

                home_team_id = payload.get("home_team_id")
                away_team_id = payload.get("away_team_id")

                if key not in amended and (home_team_id is None or away_team_id is None):
                    # Insufficient data to create a new matchup entry; skip.
                    continue

                if home_team_id is not None:
                    current["home_team_id"] = int(home_team_id)
                if away_team_id is not None:
                    current["away_team_id"] = int(away_team_id)
                if "home_points" in payload:
                    current["home_points"] = float(payload["home_points"])
                if "away_points" in payload:
                    current["away_points"] = float(payload["away_points"])
                if "winner" in payload:
                    current["winner"] = payload["winner"]
                if "notes" in payload:
                    current["notes"] = payload["notes"]

                amended[key] = current

        return amended

    def _summarize_team_projections(
        self,
        teams: dict[int, TeamMeta],
        projections: pd.DataFrame,
    ) -> dict[int, TeamProjection]:
        team_projections: dict[int, TeamProjection] = {}

        for team_id in projections["team_id"].dropna().unique():
            team_id_int = int(team_id)
            if team_id_int not in teams:
                continue

            team_rows = projections.loc[projections["team_id"] == team_id]
            starters = []
            bench = []
            total_points = 0.0

            for _, row in team_rows.iterrows():
                points = float(row.get("projected_points", 0.0))
                entry = {
                    "espn_player_id": int(row.get("espn_player_id")) if pd.notna(row.get("espn_player_id")) else None,
                    "player_name": str(row.get("player_name", "")),
                    "lineup_slot": str(row.get("lineup_slot", "")),
                    "espn_position": str(row.get("espn_position", "")),
                    "projected_points": round(points, 2),
                    "counts_for_score": bool(row.get("counts_for_score", False)),
                }
                if entry["counts_for_score"]:
                    starters.append(entry)
                    total_points += points
                else:
                    bench.append(entry)

            starters.sort(key=lambda item: item["projected_points"], reverse=True)
            bench.sort(key=lambda item: item["projected_points"], reverse=True)

            team_projections[team_id_int] = TeamProjection(
                team=teams[team_id_int],
                projected_points=round(total_points, 2),
                starters=starters,
                bench=bench,
            )

        return team_projections

    def _team_to_dict(self, team: TeamMeta) -> dict[str, object]:
        return {
            "team_id": team.team_id,
            "name": team.name,
            "abbrev": team.abbrev,
            "owners": team.owners,
            "logo_url": team.logo_url,
        }

    def _matchup_to_dict(self, matchup: MatchupProjection) -> dict[str, object]:
        return {
            "matchup_id": matchup.matchup_id,
            "week": matchup.week,
            "home": self._team_projection_to_dict(matchup.home),
            "away": self._team_projection_to_dict(matchup.away),
            "favorite_team_id": matchup.favorite_team_id,
            "projected_margin": round(matchup.projected_margin, 2),
            "home_win_probability": round(matchup.home_win_probability, 4),
            "away_win_probability": round(matchup.away_win_probability, 4),
        }

    def _team_projection_to_dict(self, projection: TeamProjection) -> dict[str, object]:
        return {
            "team": self._team_to_dict(projection.team),
            "projected_points": projection.projected_points,
            "starters": projection.starters,
            "bench": projection.bench,
        }

    def _estimate_win_probabilities(
        self,
        home_points: float,
        away_points: float,
        sigma: float,
    ) -> tuple[float, float]:
        margin = home_points - away_points
        if sigma <= 0:
            # Degenerate fallback: deterministic winner
            if margin > 0:
                return 1.0, 0.0
            if margin < 0:
                return 0.0, 1.0
            return 0.5, 0.5

        z = margin / (math.sqrt(2) * sigma)
        home_prob = 0.5 * (1.0 + math.erf(z))
        home_prob = max(0.0, min(1.0, home_prob))
        away_prob = 1.0 - home_prob
        return home_prob, away_prob

    def _run_monte_carlo(
        self,
        *,
        matchups: list[MatchupProjection],
        teams: dict[int, TeamMeta],
        team_schedule: dict[int, list[dict[str, object]]],
        iterations: int,
        playoff_slots: int,
        random_seed: Optional[int],
        base_records: dict[int, dict[str, float]],
        future_games: dict[int, int],
    ) -> dict[str, object]:
        if iterations <= 0:
            raise ValueError("iterations must be positive when running Monte Carlo")
        if playoff_slots <= 0:
            playoff_slots = 0

        rng = random.Random(random_seed)

        team_ids = list(teams.keys())

        aggregates: dict[int, dict[str, object]] = {
            team_id: {
                "win_total": 0.0,
                "loss_total": 0.0,
                "points_total": 0.0,
                "seed_counts": defaultdict(int),  # type: ignore[var-annotated]
                "playoff_count": 0,
                "top_seed_count": 0,
                "best_seed": math.inf,
                "worst_seed": 0,
            }
            for team_id in team_ids
        }

        matchup_groups: dict[int, list[MatchupProjection]] = defaultdict(list)
        for matchup in matchups:
            matchup_groups[matchup.week].append(matchup)

        for _ in range(iterations):
            wins = {
                team_id: float(base_records.get(team_id, {}).get("wins", 0.0))
                for team_id in team_ids
            }
            losses = {
                team_id: float(base_records.get(team_id, {}).get("losses", 0.0))
                for team_id in team_ids
            }
            points = {
                team_id: float(base_records.get(team_id, {}).get("points", 0.0))
                for team_id in team_ids
            }

            for week in sorted(matchup_groups.keys()):
                for matchup in matchup_groups[week]:
                    home_id = matchup.home.team.team_id
                    away_id = matchup.away.team.team_id
                    home_points = matchup.home.projected_points
                    away_points = matchup.away.projected_points

                    points[home_id] += home_points
                    points[away_id] += away_points

                    roll = rng.random()
                    if roll < matchup.home_win_probability:
                        wins[home_id] += 1
                        losses[away_id] += 1
                    else:
                        wins[away_id] += 1
                        losses[home_id] += 1

            standings_iteration = sorted(
                team_ids,
                key=lambda tid: (
                    wins[tid],
                    points[tid],
                ),
                reverse=True,
            )

            for seed_index, team_id in enumerate(standings_iteration, start=1):
                aggregates[team_id]["win_total"] += wins[team_id]
                aggregates[team_id]["loss_total"] += losses[team_id]
                aggregates[team_id]["points_total"] += points[team_id]
                aggregates[team_id]["seed_counts"][seed_index] += 1  # type: ignore[index]
                if seed_index <= playoff_slots:
                    aggregates[team_id]["playoff_count"] += 1
                if seed_index == 1:
                    aggregates[team_id]["top_seed_count"] += 1
                aggregates[team_id]["best_seed"] = min(aggregates[team_id]["best_seed"], seed_index)
                aggregates[team_id]["worst_seed"] = max(aggregates[team_id]["worst_seed"], seed_index)

        teams_payload: list[dict[str, object]] = []
        iterations_float = float(iterations)

        for team_id in team_ids:
            data = aggregates[team_id]
            wins_avg = data["win_total"] / iterations_float
            losses_avg = data["loss_total"] / iterations_float
            points_avg = data["points_total"] / iterations_float
            seed_counts = data["seed_counts"]
            seed_distribution = {
                str(seed): count / iterations_float for seed, count in sorted(seed_counts.items())
            }

            cumulative = 0.0
            median_seed = None
            for seed, count in sorted(seed_counts.items()):
                cumulative += count / iterations_float
                if cumulative >= 0.5:
                    median_seed = seed
                    break

            teams_payload.append(
                {
                    "team": self._team_to_dict(teams[team_id]),
                    "average_wins": round(wins_avg, 3),
                    "average_losses": round(losses_avg, 3),
                    "average_points": round(points_avg, 2),
                    "games_remaining": future_games.get(team_id, 0),
                    "playoff_odds": data["playoff_count"] / iterations_float,
                    "top_seed_odds": data["top_seed_count"] / iterations_float,
                    "seed_distribution": seed_distribution,
                    "best_seed": int(data["best_seed"]) if data["best_seed"] != math.inf else None,
                    "worst_seed": int(data["worst_seed"]),
                    "median_seed": median_seed,
                }
            )

        teams_payload.sort(key=lambda entry: entry["playoff_odds"], reverse=True)

        return {
            "iterations": iterations,
            "playoff_slots": playoff_slots,
            "random_seed": random_seed,
            "teams": teams_payload,
        }


_SCENARIO_FILENAME_PATTERN = re.compile(r"[^a-z0-9_-]+")


def _scenario_filename_slug(scenario_id: str) -> str:
    slug = _SCENARIO_FILENAME_PATTERN.sub("-", scenario_id.lower()).strip("-")
    return slug or "scenario"


def default_simulation_output(
    settings: AppSettings,
    season: int,
    scenario_id: str | None = None,
) -> Path:
    simulations_dir = settings.data_root / "out" / "simulations" / str(season)
    if scenario_id and scenario_id != BASELINE_SCENARIO_ID:
        slug = _scenario_filename_slug(scenario_id)
        filename = f"rest_of_season__scenario-{slug}.json"
    else:
        filename = "rest_of_season.json"
    return simulations_dir / filename
