from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Mapping, Optional, Tuple

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
    23: "FLEX",
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


def _coerce_int(value: object) -> Optional[int]:
    try:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _stringify_id(value: object) -> Optional[str]:
    if value is None or value == "":
        return None
    if isinstance(value, float):
        if pd.isna(value):
            return None
        if value.is_integer():
            return str(int(value))
        return str(value)
    return str(value)


def _isoformat_or_none(value: object) -> Optional[str]:
    if value in (None, ""):
        return None
    try:
        timestamp = pd.to_datetime(value, unit="ms", utc=True, errors="coerce")
    except (ValueError, TypeError, OverflowError):
        return None
    if pd.isna(timestamp):
        return None
    return timestamp.isoformat()


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


def normalize_league_settings(settings_view: dict) -> pd.DataFrame:
    """Extract league-level settings like playoff configuration."""
    settings = settings_view.get("settings", {})
    schedule_settings = settings.get("scheduleSettings", {})

    row = {
        "season": settings_view.get("seasonId"),
        "league_id": settings_view.get("id"),
        "league_name": settings.get("name"),
        "size": settings.get("size"),
        "regular_season_matchups": schedule_settings.get("matchupPeriodCount"),
        "matchup_period_length": schedule_settings.get("matchupPeriodLength"),
        "playoff_team_count": schedule_settings.get("playoffTeamCount"),
        "playoff_matchup_period_length": schedule_settings.get("playoffMatchupPeriodLength"),
        "playoff_reseed": schedule_settings.get("playoffReseed"),
        "playoff_seeding_rule": schedule_settings.get("playoffSeedingRule"),
        "matchup_tie_rule": settings.get("scoringSettings", {}).get("matchupTieRule"),
        "scoring_type": settings.get("scoringSettings", {}).get("scoringType"),
    }
    return pd.DataFrame([row])


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


def normalize_transactions(
    transactions_view: dict,
    team_lookup: Mapping[int, str] | None = None,
    player_lookup: Mapping[int, str] | None = None,
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    team_lookup = dict(team_lookup or {})
    player_lookup = dict(player_lookup or {})

    season = transactions_view.get("seasonId")
    transactions_rows: list[dict[str, object]] = []
    items_rows: list[dict[str, object]] = []

    for tx in transactions_view.get("transactions", []) or []:
        transaction_id = (
            _stringify_id(tx.get("id"))
            or _stringify_id(tx.get("transactionId"))
            or _stringify_id(tx.get("relatedTransactionId"))
            or _stringify_id(tx.get("proposedDate"))
        )
        team_id = _coerce_int(tx.get("teamId"))
        scoring_period = _coerce_int(tx.get("scoringPeriodId"))

        proposed_by = tx.get("proposedBy")
        proposed_by_member_id: Optional[int] = None
        proposed_by_team_id: Optional[int] = None
        if isinstance(proposed_by, dict):
            proposed_by_member_id = _coerce_int(proposed_by.get("memberId") or proposed_by.get("id"))
            proposed_by_team_id = _coerce_int(proposed_by.get("teamId"))
        else:
            proposed_by_member_id = _coerce_int(proposed_by)

        executed_date = _isoformat_or_none(tx.get("executionDate"))
        proposed_date = _isoformat_or_none(tx.get("proposedDate"))

        transactions_rows.append(
            {
                "season": season,
                "transaction_id": transaction_id,
                "type": tx.get("type"),
                "status": tx.get("status"),
                "execution_type": tx.get("executionType"),
                "is_pending": tx.get("isPending"),
                "team_id": team_id,
                "team_name": team_lookup.get(team_id),
                "member_id": _coerce_int(tx.get("memberId")),
                "proposed_by_member_id": proposed_by_member_id,
                "proposed_by_team_id": proposed_by_team_id,
                "proposed_by_team_name": team_lookup.get(proposed_by_team_id) if proposed_by_team_id else None,
                "scoring_period_id": scoring_period,
                "proposed_date": proposed_date,
                "executed_date": executed_date,
                "expiration_date": _isoformat_or_none(tx.get("expirationDate")),
                "notes": tx.get("notes") or tx.get("comment"),
            }
        )

        items = tx.get("items") or []
        for item in items:
            player = item.get("player") or {}
            player_id = _coerce_int(item.get("playerId")) or _coerce_int(player.get("id"))
            player_name = player.get("fullName") or player_lookup.get(player_id)
            from_team_id = _coerce_int(item.get("fromTeamId"))
            to_team_id = _coerce_int(item.get("toTeamId"))

            lineup_slot_id = _coerce_int(item.get("lineupSlotId"))

            items_rows.append(
                {
                    "season": season,
                    "transaction_id": transaction_id,
                    "item_id": _stringify_id(item.get("id")),
                    "item_type": item.get("type"),
                    "player_id": player_id,
                    "player_name": player_name,
                    "from_team_id": from_team_id,
                    "from_team_name": team_lookup.get(from_team_id),
                    "to_team_id": to_team_id,
                    "to_team_name": team_lookup.get(to_team_id),
                    "bid_amount": item.get("bidAmount"),
                    "waiver_order": _coerce_int(item.get("waiverOrder")),
                    "keeper_value": item.get("keeperValue"),
                    "keeper_year": item.get("keeperYear"),
                    "lineup_slot_id": lineup_slot_id,
                    "lineup_slot": LINEUP_SLOT_NAMES.get(lineup_slot_id, str(lineup_slot_id) if lineup_slot_id is not None else None),
                    "scoring_period_id": _coerce_int(item.get("scoringPeriodId")) or scoring_period,
                    "is_pending": item.get("isPending"),
                    "pending_transaction_id": _stringify_id(item.get("pendingTransactionId")),
                }
            )

    transactions_df = pd.DataFrame(transactions_rows)
    items_df = pd.DataFrame(items_rows)
    return transactions_df, items_df


def write_dataframe(df: pd.DataFrame, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)
    return path
