from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import httpx


TRADE_CHART_API = "https://api.fantasycalc.com/trade-chart/current"
REDRAFT_VALUES_API = "https://api.fantasycalc.com/values/current"


@dataclass
class FantasyCalcParams:
    is_dynasty: bool = False
    num_qbs: int = 1
    num_teams: int = 12
    ppr: float = 1.0

    def to_query(self) -> dict[str, Any]:
        return {
            "isDynasty": str(self.is_dynasty).lower(),
            "numQbs": str(self.num_qbs),
            "numTeams": str(self.num_teams),
            "ppr": str(self.ppr),
        }


def _fetch(url: str, query: dict[str, Any]) -> list[dict[str, Any]]:
    response = httpx.get(url, params=query, timeout=30.0)
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, list):
        raise ValueError("Unexpected FantasyCalc response format; expected list")
    return data


def fetch_trade_chart(params: FantasyCalcParams) -> list[dict[str, Any]]:
    return _fetch(TRADE_CHART_API, params.to_query())


def fetch_redraft_values(params: FantasyCalcParams, include_adp: bool = False) -> list[dict[str, Any]]:
    query = params.to_query()
    query["includeAdp"] = str(include_adp).lower()
    return _fetch(REDRAFT_VALUES_API, query)


def normalize_trade_chart(raw: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for entry in raw:
        value_tier = entry.get("value")
        for pos_key in ("rb", "wr", "qb", "te"):
            payload = entry.get(pos_key)
            if not payload:
                continue
            player = payload.get("player") or {}
            row = {
                "value_tier": value_tier,
                "position": player.get("position") or pos_key.upper(),
                "player_id": player.get("id"),
                "player_name": player.get("name"),
                "team": player.get("maybeTeam"),
                "age": player.get("maybeAge"),
                "value_raw": payload.get("value"),
                "overall_rank": payload.get("overallRank"),
                "position_rank": payload.get("positionRank"),
                "trend_30_day": payload.get("trend30Day"),
                "redraft_value": payload.get("redraftValue"),
                "combined_value": payload.get("combinedValue"),
                "trade_frequency": payload.get("maybeTradeFrequency"),
            }
            rows.append(row)
    return rows


def write_csv(rows: Iterable[dict[str, Any]], path: Path) -> Path:
    rows_list = list(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows_list:
        with path.open("w", newline="") as handle:
            handle.write("")
        return path

    fieldnames = list(rows_list[0].keys())
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows_list)
    return path


def write_trade_chart(rows: Iterable[dict[str, Any]], path: Path) -> Path:
    return write_csv(rows, path)
