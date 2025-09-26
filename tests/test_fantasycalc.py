from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from fantasy_nfl.fantasycalc import FantasyCalcParams, normalize_trade_chart, write_trade_chart


def sample_entry(value: int, player_name: str, position: str, raw_value: int) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "value": value,
        position.lower(): {
            "player": {
                "id": hash(player_name) % 100000,
                "name": player_name,
                "position": position,
                "maybeTeam": "TEAM",
                "maybeAge": 24.5,
            },
            "value": raw_value,
            "overallRank": 1,
            "positionRank": 1,
            "trend30Day": 10,
            "redraftValue": raw_value,
            "combinedValue": raw_value * 2,
            "maybeTradeFrequency": 0.01,
        },
    }
    return payload


def test_normalize_trade_chart_expands_positions(tmp_path: Path) -> None:
    raw = [
        {
            "value": 50,
            "rb": sample_entry(0, "Player RB", "RB", 5000)["rb"],
            "wr": sample_entry(0, "Player WR", "WR", 4800)["wr"],
        },
        sample_entry(40, "Player QB", "QB", 4500),
    ]

    rows = normalize_trade_chart(raw)
    assert len(rows) == 3
    rb_row = next(item for item in rows if item["player_name"] == "Player RB")
    assert rb_row["position"] == "RB"
    assert rb_row["value_tier"] == 50

    output = tmp_path / "trade_values.csv"
    write_trade_chart(rows, output)
    exported = pd.read_csv(output)
    assert len(exported) == 3
    assert set(exported.columns) >= {
        "player_name",
        "position",
        "value_tier",
        "value_raw",
    }


def test_params_to_query_string() -> None:
    params = FantasyCalcParams(is_dynasty=True, num_qbs=2, num_teams=14, ppr=0.5)
    query = params.to_query()
    assert query == {
        "isDynasty": "true",
        "numQbs": "2",
        "numTeams": "14",
        "ppr": "0.5",
    }
