from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable

import pandas as pd

from .settings import AppSettings

# ESPN lineup slot and position maps (standard league values)
LINEUP_SLOT_NAMES: Dict[int, str] = {
    0: "QB",
    1: "TQB",
    2: "RB",
    3: "RB/WR",
    4: "WR",
    5: "WR/TE",
    6: "TE",
    7: "OP",
    8: "DT",
    9: "DE",
    10: "LB",
    11: "DL",
    12: "CB",
    13: "S",
    14: "DB",
    15: "DP",
    16: "D/ST",
    17: "K",
    18: "P",
    19: "HC",
    20: "BE",
    21: "IR",
    22: "FLEX",
    23: "EDR",
    24: "Rookie",
    25: "Taxi",
    26: "ER",
    27: "Rookie Bench",
}

POSITION_NAMES: Dict[int, str] = {
    0: "QB",
    1: "TQB",
    2: "RB",
    3: "WR",
    4: "TE",
    5: "K",
    6: "D/ST",
    7: "DL",
    8: "DE",
    9: "LB",
    10: "DB",
    11: "HC",
}


@dataclass
class EspnSnapshot:
    settings: AppSettings

    @property
    def season_dir(self) -> Path:
        return self.settings.data_root / "raw" / "espn" / str(self.settings.espn_season)

    def load_view(self, view: str) -> dict:
        path = self.season_dir / f"view-{view}.json"
        if not path.exists():
            raise FileNotFoundError(f"Expected ESPN view file at {path}")
        return json.loads(path.read_text())


def normalize_teams(team_view: dict) -> pd.DataFrame:
    owner_lookup = {
        member["id"]: member.get("displayName") or member.get("firstName")
        for member in team_view.get("members", [])
    }

    rows = []
    for team in team_view.get("teams", []):
        owner_names = [owner_lookup.get(owner_id, owner_id) for owner_id in team.get("owners", [])]
        rows.append(
            {
                "season": team_view.get("seasonId"),
                "team_id": team.get("id"),
                "team_name": team.get("name"),
                "abbrev": team.get("abbrev"),
                "division_id": team.get("divisionId"),
                "owners": ";".join(owner_names),
                "playoff_seed": team.get("playoffSeed"),
                "logo": team.get("logo"),
            }
        )
    return pd.DataFrame(rows)


def normalize_roster(roster_view: dict) -> pd.DataFrame:
    rows = []
    season = roster_view.get("seasonId")
    scoring_period = roster_view.get("scoringPeriodId")

    for team in roster_view.get("teams", []):
        roster = team.get("roster", {})
        for entry in roster.get("entries", []):
            player = entry.get("playerPoolEntry", {}).get("player", {})
            rows.append(
                {
                    "season": season,
                    "scoring_period_id": scoring_period,
                    "team_id": team.get("id"),
                    "espn_player_id": player.get("id"),
                    "player_name": player.get("fullName"),
                    "lineup_slot_id": entry.get("lineupSlotId"),
                    "lineup_slot": LINEUP_SLOT_NAMES.get(entry.get("lineupSlotId"), str(entry.get("lineupSlotId"))),
                    "position_id": player.get("defaultPositionId"),
                    "position": POSITION_NAMES.get(player.get("defaultPositionId"), str(player.get("defaultPositionId"))),
                    "pro_team_id": player.get("proTeamId"),
                    "injury_status": entry.get("injuryStatus"),
                    "status": entry.get("status"),
                    "acquisition_type": entry.get("acquisitionType"),
                }
            )
    return pd.DataFrame(rows)


def normalize_schedule(matchup_view: dict) -> pd.DataFrame:
    rows = []
    season = matchup_view.get("seasonId")
    for game in matchup_view.get("schedule", []):
        home = game.get("home", {})
        away = game.get("away", {})
        rows.append(
            {
                "season": season,
                "matchup_id": game.get("id"),
                "matchup_period_id": game.get("matchupPeriodId"),
                "week": game.get("matchupPeriodId"),
                "home_team_id": home.get("teamId"),
                "home_points": home.get("totalPoints"),
                "away_team_id": away.get("teamId"),
                "away_points": away.get("totalPoints"),
                "winner": game.get("winner"),
            }
        )
    return pd.DataFrame(rows)


def write_dataframe(df: pd.DataFrame, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)
    return path
