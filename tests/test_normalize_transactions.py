from fantasy_nfl.normalize import normalize_transactions


def _build_sample_view() -> dict:
    return {
        "seasonId": 2025,
        "transactions": [
            {
                "id": 1,
                "type": "TRADE",
                "status": "EXECUTED",
                "executionType": "LINEUP",
                "isPending": False,
                "teamId": 1,
                "memberId": 11,
                "proposedBy": {"memberId": 11, "teamId": 1},
                "scoringPeriodId": 3,
                "proposedDate": 1_726_000_000_000,
                "executionDate": 1_726_003_600_000,
                "items": [
                    {
                        "id": 100,
                        "type": "TRADE",
                        "playerId": 555,
                        "player": {"id": 555, "fullName": "Player A"},
                        "fromTeamId": 1,
                        "toTeamId": 2,
                        "scoringPeriodId": 3,
                    },
                    {
                        "id": 101,
                        "type": "TRADE",
                        "playerId": 556,
                        "player": {"id": 556, "fullName": "Player B"},
                        "fromTeamId": 2,
                        "toTeamId": 1,
                    },
                ],
            },
            {
                "id": 2,
                "type": "WAIVER",
                "status": "EXECUTED",
                "executionType": "WAIVER",
                "isPending": False,
                "teamId": 2,
                "memberId": 22,
                "proposedDate": 1_726_100_000_000,
                "executionDate": 1_726_103_600_000,
                "items": [
                    {
                        "id": 200,
                        "type": "ADD",
                        "playerId": 600,
                        "player": {"id": 600, "fullName": "Player C"},
                        "fromTeamId": None,
                        "toTeamId": 2,
                        "bidAmount": 42,
                        "waiverOrder": 5,
                    },
                    {
                        "id": 201,
                        "type": "DROP",
                        "playerId": 601,
                        "player": {"id": 601, "fullName": "Player D"},
                        "fromTeamId": 2,
                        "toTeamId": None,
                    },
                ],
            },
        ],
    }


def test_normalize_transactions_returns_flat_tables():
    view = _build_sample_view()
    team_lookup = {1: "Team One", 2: "Team Two"}
    player_lookup = {555: "Player A", 556: "Player B", 600: "Player C", 601: "Player D"}

    tx_df, items_df = normalize_transactions(view, team_lookup=team_lookup, player_lookup=player_lookup)

    assert len(tx_df) == 2
    assert set(tx_df["transaction_id"]) == {"1", "2"}

    trade = tx_df.loc[tx_df["transaction_id"] == "1"].iloc[0]
    assert trade["team_name"] == "Team One"
    assert trade["executed_date"].endswith("+00:00")
    assert trade["proposed_by_team_name"] == "Team One"

    assert len(items_df) == 4
    items_sorted = items_df.sort_values(["transaction_id", "item_id"]).reset_index(drop=True)
    first = items_sorted.iloc[0]
    assert first["player_name"] == "Player A"
    assert first["from_team_name"] == "Team One"
    assert first["to_team_name"] == "Team Two"

    waiver_add = items_sorted.iloc[2]
    assert waiver_add["item_type"] == "ADD"
    assert waiver_add["bid_amount"] == 42
    assert waiver_add["waiver_order"] == 5
