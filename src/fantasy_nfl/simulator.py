from __future__ import annotations

import json
import math
import random
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd

from .settings import AppSettings


DEFAULT_SIGMA = 18.0  # point spread standard deviation assumption for win probabilities
DEFAULT_SIMULATIONS = 500
DEFAULT_PLAYOFF_SLOTS = 4


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
        if not scores_path.exists():
            return pd.DataFrame()

        df = pd.read_csv(scores_path)
        if "counts_for_score" in df.columns:
            df["counts_for_score"] = (
                df["counts_for_score"].astype(str).str.lower().isin(["true", "1", "yes"])
            )
        else:
            df["counts_for_score"] = True
        df["team_id"] = pd.to_numeric(df.get("team_id"), errors="coerce").astype("Int64")
        df["score_total"] = pd.to_numeric(df.get("score_total"), errors="coerce").fillna(0.0)
        return df

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

        return results

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
    ) -> dict[str, object]:
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

                if winner == "HOME":
                    home_prob_final, away_prob_final = 1.0, 0.0
                    home_result, away_result = "win", "loss"
                elif winner == "AWAY":
                    home_prob_final, away_prob_final = 0.0, 1.0
                    home_result, away_result = "loss", "win"
                elif winner == "TIE":
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

                home_proj.projected_points = round(home_points, 2)
                away_proj.projected_points = round(away_points, 2)

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

        return dataset

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
        if not proj_path.exists():
            return pd.DataFrame()
        df = pd.read_csv(proj_path)
        if "counts_for_score" in df.columns:
            df["counts_for_score"] = df["counts_for_score"].astype(str).str.lower().isin(["true", "1", "yes"])
        else:
            df["counts_for_score"] = False
        df["projected_points"] = pd.to_numeric(df.get("projected_points"), errors="coerce").fillna(0.0)
        df["team_id"] = pd.to_numeric(df.get("team_id"), errors="coerce").astype("Int64")
        return df

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


def default_simulation_output(settings: AppSettings, season: int) -> Path:
    return settings.data_root / "out" / "simulations" / str(season) / "rest_of_season.json"
