from __future__ import annotations

import csv
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import click
import pandas as pd

from .auth import EspnAuthenticator
from .espn import EspnClient, ensure_views
from .merge import DataAssembler
from .normalize import (
    EspnSnapshot,
    normalize_league_settings,
    normalize_roster,
    normalize_schedule,
    normalize_teams,
    normalize_transactions,
    write_dataframe,
)
from .projection_providers import (
    PROVIDER_ESPN,
    PROVIDER_USAGE,
    build_projection_baseline,
)
from .projections import ProjectionManager
from .scoring import ScoreEngine, ScoringConfig
from .nflverse import NflverseDownloader
from .settings import AppSettings, get_settings
from .espn_nfl import (
    NFLGameState,
    calculate_live_projection,
    fetch_nfl_scoreboard,
    load_nfl_game_state,
    parse_nfl_game_states,
    save_nfl_game_state,
)
from .fantasycalc import (
    FantasyCalcParams,
    fetch_redraft_values,
    fetch_trade_chart,
    normalize_trade_chart,
    write_csv,
)
from .simulator import (
    DEFAULT_PLAYOFF_SLOTS,
    DEFAULT_SIGMA,
    DEFAULT_SIMULATIONS,
    RestOfSeasonSimulator,
    default_simulation_output,
)
from .overlays import (
    BASELINE_SCENARIO_ID,
    CompletedWeekOverride,
    OverlayStore,
    ProjectionWeekOverride,
)


def _mask_value(show_secrets: bool, raw: Optional[str], masked: Optional[str]) -> str:
    if show_secrets:
        return raw or ""
    return masked or ""


def _env_rows(settings: AppSettings, show_secrets: bool) -> list[tuple[str, str]]:
    return [
        ("ESPN_EMAIL", _mask_value(show_secrets, settings.espn_email, settings.masked_email)),
        (
            "ESPN_PASSWORD",
            _mask_value(show_secrets, settings.espn_password, "***" if settings.espn_password else ""),
        ),
        ("ESPN_S2", _mask_value(show_secrets, settings.espn_s2, settings.masked_cookie(settings.espn_s2))),
        ("ESPN_SWID", _mask_value(show_secrets, settings.espn_swid, settings.masked_cookie(settings.espn_swid))),
        ("ESPN_LEAGUE_ID", settings.espn_league_id or ""),
        ("ESPN_SEASON", str(settings.espn_season or "")),
        ("DATA_ROOT", str(settings.data_root)),
        ("LOG_LEVEL", settings.log_level),
    ]


@click.group()
def cli() -> None:
    """Fantasy NFL data pipeline CLI."""


@cli.command()
@click.option("--show-secrets", is_flag=True, help="Display raw credential values. Use with caution.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def env(show_secrets: bool, env_file: Path) -> None:
    """Show the current environment configuration."""

    settings = get_settings(env_file)
    rows = _env_rows(settings, show_secrets)
    width = max(len(key) for key, _ in rows)
    for key, value in rows:
        click.echo(f"{key.ljust(width)} : {value}")


@cli.group()
def auth() -> None:
    """Authentication helpers."""


@auth.command("login")
@click.option(
    "--league-url",
    type=str,
    help="Optional fantasy URL to visit post-login (ensures cookies for private leagues).",
)
@click.option("--api", "api_only", is_flag=True, help="Force HTTP-only login; skip browser automation.")
@click.option("--browser", "browser_only", is_flag=True, help="Force browser automation fallback.")
@click.option("--show-browser", is_flag=True, help="Show the Chromium window when using browser mode.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def auth_login(
    league_url: Optional[str],
    api_only: bool,
    browser_only: bool,
    show_browser: bool,
    env_file: Path,
) -> None:
    """Obtain ESPN cookies using configured email/password and cache them locally."""

    if api_only and browser_only:
        raise click.BadParameter("Use only one of --api or --browser")

    settings = get_settings(env_file)
    authenticator = EspnAuthenticator(settings)

    effective_league_url = (
        league_url
        or (
            f"https://fantasy.espn.com/football/team?leagueId={settings.espn_league_id}&teamId=1"
            if settings.espn_league_id
            else None
        )
    )

    mode = "api" if api_only else "browser" if browser_only else "auto"
    headless = not show_browser

    cookies = authenticator.login(
        league_url=effective_league_url,
        mode=mode,
        headless=headless,
    )
    masked = cookies.masked()
    click.echo("Successfully captured ESPN cookies:")
    click.echo(f"  espn_s2: {masked['espn_s2']}")
    click.echo(f"  swid:    {masked['swid']}")
    click.echo("Saved to data/raw/auth/espn_cookies.json")


@auth.command("manual")
@click.option(
    "--league-url",
    type=str,
    help="Optional target page to open after login (defaults to league home).",
)
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def auth_manual(league_url: Optional[str], env_file: Path) -> None:
    """Launch a visible browser session so you can log in manually and capture cookies."""

    settings = get_settings(env_file)
    authenticator = EspnAuthenticator(settings)

    effective_league_url = (
        league_url
        or (
            f"https://fantasy.espn.com/football/team?leagueId={settings.espn_league_id}&teamId=1"
            if settings.espn_league_id
            else None
        )
    )

    click.echo(
        "A Chromium window will open. Complete the ESPN login there, then return to this terminal "
        "and press Enter when prompted."
    )

    cookies = authenticator.manual_login(league_url=effective_league_url, headless=False)
    masked = cookies.masked()
    click.echo("Successfully captured ESPN cookies:")
    click.echo(f"  espn_s2: {masked['espn_s2']}")
    click.echo(f"  swid:    {masked['swid']}")
    click.echo("Saved to data/raw/auth/espn_cookies.json")


@cli.group()
def espn() -> None:
    """ESPN data utilities."""


@espn.command("pull")
@click.option(
    "--view",
    "views",
    multiple=True,
    help="Specific ESPN views to request (defaults to common views).",
)
@click.option(
    "--list", "show_views", is_flag=True, help="List default views and exit without fetching.",
)
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def espn_pull(views: tuple[str, ...], show_views: bool, env_file: Path) -> None:
    """Fetch ESPN league JSON views and cache them under data/raw/espn."""

    selected_views = ensure_views(views)
    if show_views:
        click.echo("Default views:")
        for view in selected_views:
            click.echo(f"  - {view}")
        return

    settings = get_settings(env_file)
    with EspnClient(settings) as client:
        for view in selected_views:
            data = client.fetch_view(view)
            path = client.save_view(view, data)
            click.echo(f"Saved {view} → {path}")


@espn.command("normalize")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def espn_normalize(env_file: Path) -> None:
    """Normalize cached ESPN JSON views into tabular CSV outputs."""

    settings = get_settings(env_file)
    snapshot = EspnSnapshot(settings)

    team_view = snapshot.load_view("mTeam")
    roster_view = snapshot.load_view("mRoster")
    matchup_view = snapshot.load_view("mMatchup")
    settings_view = snapshot.load_view("mSettings")

    teams_df = normalize_teams(team_view)
    roster_df = normalize_roster(roster_view)
    schedule_df = normalize_schedule(matchup_view)
    league_settings_df = normalize_league_settings(settings_view)

    out_dir = settings.data_root / "out" / "espn" / str(settings.espn_season)
    teams_csv = write_dataframe(teams_df, out_dir / "teams.csv")
    roster_csv = write_dataframe(roster_df, out_dir / "roster.csv")
    schedule_csv = write_dataframe(schedule_df, out_dir / "schedule.csv")
    league_settings_csv = write_dataframe(league_settings_df, out_dir / "league_settings.csv")

    click.echo(f"Saved roster → {roster_csv}")
    click.echo(f"Saved teams → {teams_csv}")
    click.echo(f"Saved schedule → {schedule_csv}")
    click.echo(f"Saved league settings → {league_settings_csv}")


@espn.command("build-week")
@click.option("--season", type=int, default=None, help="Season for weekly stats (defaults to .env ESPN_SEASON).")
@click.option("--week", type=int, default=None, help="Optional week number to filter stats.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def espn_build_week(season: int | None, week: int | None, env_file: Path) -> None:
    """Join ESPN roster with nflverse players + weekly stats for scoring."""

    settings = get_settings(env_file)
    target_season = season or settings.espn_season
    if target_season is None:
        raise click.BadParameter("Season must be provided via --season or ESPn season in .env")

    assembler = DataAssembler(settings)
    roster_enriched = assembler.merge_roster_players()
    click.echo(f"Roster enriched → {assembler.roster_enriched_path()}")
    merged = assembler.merge_with_weekly(target_season, week)
    output_path = assembler.weekly_output_path(target_season, week)
    click.echo(f"Weekly dataset → {output_path} ({len(merged)} rows)")


@cli.group()
def nflverse() -> None:
    """nflverse data utilities."""
@cli.group("nfl")
def nfl() -> None:
    """NFL live game data commands."""


@nfl.command("fetch-game-state")
@click.option("--season", type=int, required=True)
@click.option("--week", type=int, required=True)
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def nfl_fetch_game_state(season: int, week: int, env_file: Path) -> None:
    """Fetch live NFL game state from ESPN NFL API and save to data/raw/nfl/<season>/game_state_week_<week>.json."""

    settings = get_settings(env_file)
    click.echo(f"Fetching NFL game state for week {week}...")
    try:
        scoreboard = fetch_nfl_scoreboard(week=week)
        game_states = parse_nfl_game_states(scoreboard)
        click.echo(f"Found {len(game_states)} NFL team game states")
        output_path = (
            settings.data_root
            / "raw"
            / "nfl"
            / str(season)
            / f"game_state_week_{week}.json"
        )
        saved = save_nfl_game_state(game_states, output_path)
        click.echo(f"Saved game state → {saved}")
    except Exception as exc:  # pragma: no cover - network/runtime dependent
        raise click.ClickException(f"Failed to fetch NFL game state: {exc}") from exc



@nflverse.command("pull")
@click.option(
    "--season",
    type=int,
    default=None,
    help="Season for weekly stats (defaults to ESPn season from .env).",
)
@click.option("--force", is_flag=True, help="Force re-download even if cache exists.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def nflverse_pull(season: int | None, force: bool, env_file: Path) -> None:
    """Download nflverse player master + weekly stats and cache locally."""

    settings = get_settings(env_file)
    target_season = season or settings.espn_season
    if target_season is None:
        raise click.BadParameter("Season must be provided via --season or ESPn season in .env")

    downloader = NflverseDownloader(settings)
    players_csv = downloader.fetch_players(force=force)
    weekly_csv = downloader.fetch_weekly(target_season, force=force)

    click.echo(f"Players → {players_csv}")
    click.echo(f"Weekly stats {target_season} → {weekly_csv}")


@cli.group()
def score() -> None:
    """Fantasy scoring utilities."""


@score.command("week")
@click.option("--season", type=int, default=None, help="Season to score (defaults to ESPn season in .env).")
@click.option("--week", type=int, required=True, help="Week number to score.")
@click.option(
    "--config",
    "config_path",
    type=click.Path(path_type=Path, dir_okay=False, exists=True, readable=True),
    default=Path("config/scoring.yaml"),
    show_default=True,
    help="Path to the scoring configuration file.",
)
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def score_week(season: int | None, week: int, config_path: Path, env_file: Path) -> None:
    """Compute fantasy points for a given week."""

    settings = get_settings(env_file)
    target_season = season or settings.espn_season
    if target_season is None:
        raise click.BadParameter("Season must be provided via --season or ESPn season in .env")

    config = ScoringConfig.load(config_path)
    engine = ScoreEngine(settings, config)
    scored, output_path = engine.score_week(target_season, week)

    active_count = int(scored["counts_for_score"].sum()) if not scored.empty else 0
    click.echo(
        f"Weekly scores → {output_path} ({len(scored)} rows; {active_count} counted for scoring)"
    )


@cli.command("refresh-week")
@click.option("--season", type=int, default=None, help="Season to refresh (defaults to ESPn season in .env).")
@click.option(
    "--week",
    type=int,
    default=None,
    help="Week number to refresh; defaults to current scoring period reported by ESPN.",
)
@click.option(
    "--config",
    "config_path",
    type=click.Path(path_type=Path, dir_okay=False, exists=True, readable=True),
    default=Path("config/scoring.yaml"),
    show_default=True,
    help="Path to the scoring configuration file.",
)
@click.option("--force-nflverse", is_flag=True, help="Force re-download of nflverse datasets.")
@click.option("--skip-score", is_flag=True, help="Skip scoring stage (useful for quick builds).")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def refresh_week(
    season: int | None,
    week: int | None,
    config_path: Path,
    force_nflverse: bool,
    skip_score: bool,
    env_file: Path,
) -> None:
    """Run pull → normalize → merge → score as a single step for a given week."""

    settings = get_settings(env_file)
    target_season = season or settings.espn_season
    if target_season is None:
        raise click.BadParameter("Season must be provided via --season or ESPn season in .env")

    settings.espn_season = target_season

    selected_views = ensure_views(None)
    cached_views: dict[str, dict] = {}
    with EspnClient(settings) as client:
        for view in selected_views:
            extra_params: dict[str, object] | None = None
            suffix: str | None = None

            if week is not None:
                if view == "mRoster":
                    extra_params = {"scoringPeriodId": week}
                    suffix = f"week-{week}"
                elif view == "mMatchup":
                    extra_params = {"matchupPeriodId": week}
                    suffix = f"week-{week}"
            if view == "mTransactions2":
                extra_params = {"limit": 1000}

            data = client.fetch_view(view, params=extra_params)
            path = client.save_view(view, data, suffix=suffix)
            cached_views[view] = data
            click.echo(f"Saved {view} → {path}")

    snapshot = EspnSnapshot(settings)
    team_view = cached_views.get("mTeam") or snapshot.load_view("mTeam")
    roster_view = cached_views.get("mRoster") or snapshot.load_view("mRoster")
    matchup_view = cached_views.get("mMatchup") or snapshot.load_view("mMatchup")
    settings_view = cached_views.get("mSettings") or snapshot.load_view("mSettings")

    teams_df = normalize_teams(team_view)
    roster_df = normalize_roster(roster_view)
    schedule_df = normalize_schedule(matchup_view)
    league_settings_df = normalize_league_settings(settings_view)

    out_dir = settings.data_root / "out" / "espn" / str(target_season)
    teams_csv = write_dataframe(teams_df, out_dir / "teams.csv")
    roster_csv = write_dataframe(roster_df, out_dir / "roster.csv")
    schedule_csv = write_dataframe(schedule_df, out_dir / "schedule.csv")
    league_settings_csv = write_dataframe(league_settings_df, out_dir / "league_settings.csv")

    click.echo(f"Saved teams → {teams_csv}")
    click.echo(f"Saved roster → {roster_csv}")
    click.echo(f"Saved schedule → {schedule_csv}")
    click.echo(f"Saved league settings → {league_settings_csv}")

    transactions_view = cached_views.get("mTransactions2")
    if transactions_view is None:
        try:
            transactions_view = snapshot.load_view("mTransactions2")
        except FileNotFoundError:
            transactions_view = None

    def _safe_int(value: object) -> int | None:
        try:
            if value is None or (isinstance(value, float) and math.isnan(value)):
                return None
            return int(value)
        except (TypeError, ValueError):
            return None

    team_lookup: dict[int, str] = {}
    if not teams_df.empty:
        for row in teams_df.to_dict(orient="records"):
            team_id = _safe_int(row.get("team_id"))
            team_name = row.get("team_name")
            if team_id is not None and team_name:
                team_lookup[team_id] = str(team_name)

    player_lookup: dict[int, str] = {}
    if not roster_df.empty:
        for row in roster_df.to_dict(orient="records"):
            pid = _safe_int(row.get("espn_player_id"))
            name = row.get("player_name")
            if pid is not None and name and pid not in player_lookup:
                player_lookup[pid] = str(name)

    if transactions_view is not None:
        transactions_df, items_df = normalize_transactions(
            transactions_view,
            team_lookup=team_lookup,
            player_lookup=player_lookup,
        )
        transactions_csv = write_dataframe(transactions_df, out_dir / "transactions.csv")
        items_csv = write_dataframe(items_df, out_dir / "transaction_items.csv")
        click.echo(f"Saved transactions → {transactions_csv}")
        click.echo(f"Saved transaction items → {items_csv}")
    else:
        click.echo(
            "Skipping transactions export (view-mTransactions2 missing; run `fantasy espn pull --view mTransactions2`)",
            err=True,
        )

    inferred_week = week
    if inferred_week is None and isinstance(roster_view, dict):
        inferred_week = roster_view.get("scoringPeriodId")
    if inferred_week is None:
        raise click.BadParameter(
            "Week must be provided when ESPN roster does not report a scoring period"
        )

    try:
        target_week = int(inferred_week)
    except (TypeError, ValueError) as exc:
        raise click.BadParameter(f"Unable to determine week from value {inferred_week!r}") from exc

    with EspnClient(settings) as live_client:
        filter_payload = {
            "schedule": {
                "filterMatchupPeriodIds": {"value": [target_week]},
                "filterIncludeLiveScoring": {"value": [True]},
            }
        }
        try:
            response = live_client._client.get(
                live_client.base_url,
                params={"view": "mScoreboard"},
                headers={"X-Fantasy-Filter": json.dumps(filter_payload)},
            )
            response.raise_for_status()
            scoreboard = response.json()
        except Exception as exc:  # pragma: no cover - network/runtime dependent
            click.echo(f"Skipping mScoreboard ({exc})", err=True)
        else:
            scoreboard_path = live_client.save_view("mScoreboard", scoreboard, suffix=f"week-{target_week}")
            click.echo(f"Saved mScoreboard → {scoreboard_path}")

    # Fetch NFL game state for live blending and archival (best effort)
    click.echo(f"[3/7] Fetching NFL game state for week {target_week}")
    try:
        nfl_output_path = (
            settings.data_root
            / "raw"
            / "nfl"
            / str(target_season)
            / f"game_state_week_{target_week}.json"
        )
        states = parse_nfl_game_states(fetch_nfl_scoreboard(week=target_week))
        save_nfl_game_state(states, nfl_output_path)
        click.echo(f"Saved {len(states)} NFL team game states → {nfl_output_path}")
    except Exception as exc:  # pragma: no cover - network/runtime dependent
        click.echo(f"Warning: Failed to fetch NFL game state: {exc}", err=True)

    downloader = NflverseDownloader(settings)
    players_csv = downloader.fetch_players(force=force_nflverse)
    click.echo(f"Players → {players_csv}")

    weekly_csv: Path | None = None
    try:
        weekly_csv = downloader.fetch_weekly(target_season, force=force_nflverse)
    except Exception as exc:  # pragma: no cover - network/runtime dependent
        click.echo(
            f"Weekly stats {target_season} download failed ({exc}); falling back to play-by-play aggregation.",
            err=True,
        )
    else:
        click.echo(f"Weekly stats {target_season} → {weekly_csv}")

    assembler = DataAssembler(settings)
    merged = assembler.merge_with_weekly(target_season, target_week)
    roster_enriched_path = assembler.roster_enriched_path()
    weekly_output_path = assembler.weekly_output_path(target_season, target_week)

    if roster_enriched_path.exists():
        click.echo(f"Roster enriched → {roster_enriched_path}")
    click.echo(f"Weekly dataset → {weekly_output_path} ({len(merged)} rows)")

    if skip_score:
        click.echo("Skipping scoring stage (per --skip-score)")
        return

    config = ScoringConfig.load(config_path)
    engine = ScoreEngine(settings, config)
    scored, scores_path = engine.score_week(target_season, target_week)

    active_count = int(scored["counts_for_score"].sum()) if not scored.empty else 0
    click.echo(
        f"Weekly scores → {scores_path} ({len(scored)} rows; {active_count} counted for scoring)"
    )

    return target_week


@cli.group()
def audit() -> None:
    """Validation helpers."""


@cli.group()
def projections() -> None:
    """Projection utilities."""


@cli.group()
def calc() -> None:
    """FantasyCalc utilities."""


@cli.group()
def sim() -> None:
    """Season simulation utilities."""


@cli.group()
def scenario() -> None:
    """Scenario overlay management."""


def _resolve_target_season(settings: AppSettings, explicit: int | None) -> int:
    season = explicit or settings.espn_season
    if season is None:
        raise click.BadParameter("Season must be provided via --season or ESPn season in .env")
    return season


def _bool_from_value(value: object, *, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"true", "1", "yes", "y"}


def _load_weekly_scores_for_overlay(settings: AppSettings, season: int, week: int) -> dict[str, object]:
    scores_path = (
        settings.data_root
        / "out"
        / "espn"
        / str(season)
        / f"weekly_scores_{season}_week_{week}.csv"
    )
    if not scores_path.exists():
        raise FileNotFoundError(
            f"Missing weekly scores for season {season}, week {week}: {scores_path}"
        )

    df = pd.read_csv(scores_path)
    if df.empty:
        return {"teams": {}}

    if "counts_for_score" in df.columns:
        df["counts_for_score"] = df["counts_for_score"].apply(lambda value: _bool_from_value(value, default=True))
    else:
        df["counts_for_score"] = True

    teams: dict[str, dict[str, object]] = {}
    for team_id in df["team_id"].dropna().unique():
        team_rows = df.loc[df["team_id"] == team_id]
        entries: list[dict[str, object]] = []
        for _, row in team_rows.iterrows():
            entry: dict[str, object] = {
                "player_name": row.get("player_name", ""),
                "lineup_slot": row.get("lineup_slot", ""),
                "espn_position": row.get("espn_position", ""),
                "score_total": float(row.get("score_total", 0.0) or 0.0),
                "counts_for_score": bool(row.get("counts_for_score", True)),
            }
            if not pd.isna(row.get("espn_player_id")):
                entry["espn_player_id"] = int(row.get("espn_player_id"))
            for bonus_key in ("score_base", "score_bonus", "score_position"):
                if bonus_key in row and not pd.isna(row[bonus_key]):
                    entry[bonus_key] = float(row[bonus_key])
            entries.append(entry)

        teams[str(int(team_id))] = {"entries": entries}

    return {"teams": teams}


def _load_matchups_for_overlay(settings: AppSettings, season: int, week: int) -> dict[str, object]:
    raw_path = settings.data_root / "raw" / "espn" / str(season) / "view-mMatchup.json"
    matchups: dict[str, dict[str, object]] = {}

    data: dict[str, object] | None = None
    if raw_path.exists():
        try:
            data = json.loads(raw_path.read_text())
        except json.JSONDecodeError:
            data = None

    if data and isinstance(data, dict):
        for matchup in data.get("schedule", []):
            if not isinstance(matchup, dict):
                continue
            if int(matchup.get("matchupPeriodId", -1)) != week:
                continue
            matchup_id = str(matchup.get("id"))
            home = matchup.get("home", {}) or {}
            away = matchup.get("away", {}) or {}
            matchups[matchup_id] = {
                "home_team_id": int(home.get("teamId")) if home.get("teamId") is not None else None,
                "away_team_id": int(away.get("teamId")) if away.get("teamId") is not None else None,
                "home_points": float(home.get("totalPoints", 0.0) or 0.0),
                "away_points": float(away.get("totalPoints", 0.0) or 0.0),
                "winner": (matchup.get("winner") or "").upper() or None,
            }

    if matchups:
        # Drop None team ids if the view-mMatchup payload had gaps
        for payload in matchups.values():
            if payload.get("home_team_id") is None or payload.get("away_team_id") is None:
                break
        else:
            return {"matchups": matchups}

    # Fallback to schedule.csv
    schedule_path = settings.data_root / "out" / "espn" / str(season) / "schedule.csv"
    if not schedule_path.exists():
        return {"matchups": matchups}

    schedule_df = pd.read_csv(schedule_path)
    filtered = schedule_df.loc[schedule_df["week"] == week]
    for _, row in filtered.iterrows():
        matchup_id = str(row.get("matchup_id"))
        entry = {
            "home_team_id": int(row.get("home_team_id")) if not pd.isna(row.get("home_team_id")) else None,
            "away_team_id": int(row.get("away_team_id")) if not pd.isna(row.get("away_team_id")) else None,
            "home_points": float(row.get("home_points", 0.0) or 0.0),
            "away_points": float(row.get("away_points", 0.0) or 0.0),
            "winner": (row.get("winner") or "").upper() or None,
        }
        matchups[matchup_id] = entry

    return {"matchups": matchups}


def _load_projection_week_for_overlay(settings: AppSettings, season: int, week: int) -> dict[str, object]:
    proj_path = (
        settings.data_root
        / "out"
        / "projections"
        / str(season)
        / f"projected_stats_week_{week}.csv"
    )
    if not proj_path.exists():
        raise FileNotFoundError(
            f"Missing projections for season {season}, week {week}: {proj_path}"
        )

    df = pd.read_csv(proj_path)
    if df.empty:
        return {"teams": {}}

    if "counts_for_score" in df.columns:
        df["counts_for_score"] = df["counts_for_score"].apply(lambda value: _bool_from_value(value, default=False))
    else:
        df["counts_for_score"] = False

    teams: dict[str, dict[str, object]] = {}
    for team_id in df["team_id"].dropna().unique():
        team_rows = df.loc[df["team_id"] == team_id]
        entries: list[dict[str, object]] = []
        for _, row in team_rows.iterrows():
            entry: dict[str, object] = {
                "player_name": row.get("player_name", ""),
                "lineup_slot": row.get("lineup_slot", ""),
                "espn_position": row.get("espn_position", ""),
                "projected_points": float(row.get("projected_points", 0.0) or 0.0),
                "counts_for_score": bool(row.get("counts_for_score", False)),
            }
            if not pd.isna(row.get("espn_player_id")):
                entry["espn_player_id"] = int(row.get("espn_player_id"))
            entries.append(entry)

        teams[str(int(team_id))] = {"entries": entries}

    return {"teams": teams}


def _load_overlay_document(settings: AppSettings, season: int, scenario_id: str) -> tuple[Path, dict[str, object]]:
    overlay_path = settings.data_root / "overlays" / str(season) / f"{scenario_id}.json"
    if not overlay_path.exists():
        raise click.ClickException(
            f"Overlay not found for scenario '{scenario_id}' in season {season}: {overlay_path}"
        )
    try:
        document = json.loads(overlay_path.read_text())
    except json.JSONDecodeError as exc:
        raise click.ClickException(f"Overlay JSON is invalid: {overlay_path}") from exc
    return overlay_path, document


def _parse_stat_pairs(pairs: tuple[str, ...]) -> dict[str, float]:
    stats: dict[str, float] = {}
    for raw in pairs:
        if '=' not in raw:
            raise click.BadParameter(f"Invalid --stat value '{raw}'. Use key=value format.")
        key, value = raw.split('=', 1)
        key = key.strip()
        if not key:
            raise click.BadParameter(f"Invalid --stat value '{raw}'. Stat name is required.")
        try:
            stats[key] = float(value.strip())
        except ValueError as exc:
            raise click.BadParameter(f"Invalid numeric value for stat '{key}': {value}") from exc
    return stats


def _load_weekly_scores_df(settings: AppSettings, season: int, week: int) -> pd.DataFrame:
    path = settings.data_root / "out" / "espn" / str(season) / f"weekly_scores_{season}_week_{week}.csv"
    if not path.exists():
        raise click.ClickException(f"Weekly scores file not found: {path}")
    return pd.read_csv(path)


def _locate_player_row(df: pd.DataFrame, player_id: int | None, player_name: str | None) -> dict[str, object]:
    if player_id is not None:
        match = df.loc[df.get('espn_player_id') == player_id]
        if not match.empty:
            return match.iloc[0].to_dict()
    if player_name:
        lowered = player_name.lower().strip()
        match = df.loc[df.get('player_name', '').astype(str).str.lower() == lowered]
        if not match.empty:
            return match.iloc[0].to_dict()
    raise click.ClickException("Player not found in baseline weekly scores; ensure --player-id or --player-name matches ESPN data.")


def _load_projection_df(settings: AppSettings, season: int, week: int) -> pd.DataFrame:
    path = settings.data_root / "out" / "projections" / str(season) / f"projected_stats_week_{week}.csv"
    if not path.exists():
        raise click.ClickException(f"Projection file not found: {path}")
    return pd.read_csv(path)


def _locate_projection_row(df: pd.DataFrame, player_id: int | None, player_name: str | None) -> dict[str, object]:
    if player_id is not None:
        match = df.loc[df.get('espn_player_id') == player_id]
        if not match.empty:
            return match.iloc[0].to_dict()
    if player_name:
        lowered = player_name.lower().strip()
        match = df.loc[df.get('player_name', '').astype(str).str.lower() == lowered]
        if not match.empty:
            return match.iloc[0].to_dict()
    raise click.ClickException("Player not found in baseline projection data; ensure --player-id or --player-name matches.")

def _write_overlay_document(path: Path, document: dict[str, object]) -> None:
    document["updated_at"] = datetime.now(timezone.utc).isoformat()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2) + "\n")


def _ensure_week_section(payload: dict[str, object], section: str, week: int) -> dict[str, object]:
    weeks = payload.setdefault(section, {})
    if not isinstance(weeks, dict):
        raise click.ClickException(f"Scenario payload has unexpected {section!r} structure.")
    week_payload = weeks.setdefault(str(week), {})
    if not isinstance(week_payload, dict):
        raise click.ClickException(f"Scenario payload has unexpected data for week {week}.")
    return week_payload


def _ensure_team_entries(container: dict[str, object], team_id: int, value_key: str) -> list[dict[str, object]]:
    teams = container.setdefault("teams", {})
    if not isinstance(teams, dict):
        raise click.ClickException("Scenario payload has unexpected team data.")
    team_payload = teams.setdefault(str(team_id), {})
    if not isinstance(team_payload, dict):
        raise click.ClickException("Scenario payload has unexpected team entry format.")
    entries = team_payload.setdefault("entries", [])
    if not isinstance(entries, list):
        raise click.ClickException("Scenario payload has unexpected entries list.")
    # ensure value key present on entries (for backward compatibility)
    for entry in entries:
        if value_key not in entry:
            entry.setdefault(value_key, 0.0)
    return entries


def _sum_entries(
    entries: list[dict[str, object]],
    value_key: str,
    *,
    include_override: bool = False,
) -> float:
    total = 0.0
    for entry in entries:
        if entry.get("scenario_override") and not include_override:
            continue
        if entry.get("counts_for_score", True):
            try:
                total += float(entry.get(value_key, 0.0) or 0.0)
            except (TypeError, ValueError):
                continue
    return total


def _override_adjustment(entries: list[dict[str, object]], value_key: str) -> float:
    adjustment = 0.0
    for entry in entries:
        if entry.get("scenario_override"):
            try:
                adjustment += float(entry.get(value_key, 0.0) or 0.0)
            except (TypeError, ValueError):
                continue
    return adjustment


def _total_with_override(entries: list[dict[str, object]], value_key: str) -> float:
    return _sum_entries(entries, value_key, include_override=False) + _override_adjustment(
        entries, value_key
    )


def _set_team_total(entries: list[dict[str, object]], value_key: str, points: float) -> None:
    base_sum = _sum_entries(entries, value_key, include_override=False)
    diff = float(points) - base_sum

    override_entry = None
    for entry in entries:
        if entry.get("scenario_override"):
            override_entry = entry
            break

    if abs(diff) < 1e-6:
        if override_entry is not None:
            entries.remove(override_entry)
        return

    if override_entry is None:
        override_entry = {
            "player_name": "Scenario Override",
            "lineup_slot": "TOTAL",
            "espn_position": "",
            "counts_for_score": True,
            "scenario_override": True,
        }
        entries.append(override_entry)

    override_entry[value_key] = diff


def _baseline_team_total(baseline: dict[str, object], team_id: int, value_key: str) -> float:
    teams = baseline.get("teams", {})
    if not isinstance(teams, dict):
        return 0.0
    team_payload = teams.get(str(team_id))
    if not isinstance(team_payload, dict):
        return 0.0
    entries = team_payload.get("entries", [])
    if not isinstance(entries, list):
        return 0.0
    return _sum_entries(entries, value_key)


def _find_player_entry(
    entries: list[dict[str, object]],
    *,
    player_id: int | None = None,
    player_name: str | None = None,
) -> dict[str, object] | None:
    if player_id is not None:
        for entry in entries:
            if entry.get("espn_player_id") == player_id:
                return entry
    if player_name:
        lowered = player_name.lower().strip()
        for entry in entries:
            if str(entry.get("player_name", "")).lower().strip() == lowered:
                return entry
    return None


def _update_matchup_totals(
    week_payload: dict[str, object],
    team_id: int,
    *,
    total: float,
) -> None:
    matchups = week_payload.get("matchups")
    if not isinstance(matchups, dict):
        return
    for entry in matchups.values():
        if not isinstance(entry, dict):
            continue
        changed = False
        if entry.get("home_team_id") == team_id:
            entry["home_points"] = float(total)
            changed = True
        elif entry.get("away_team_id") == team_id:
            entry["away_points"] = float(total)
            changed = True
        else:
            continue
        if changed:
            try:
                home_points = float(entry.get("home_points", 0.0) or 0.0)
                away_points = float(entry.get("away_points", 0.0) or 0.0)
            except (TypeError, ValueError):
                continue
            if abs(home_points - away_points) < 1e-6:
                entry["winner"] = "TIE"
            elif home_points > away_points:
                entry["winner"] = "HOME"
            else:
                entry["winner"] = "AWAY"


@sim.command("rest-of-season")
@click.option("--season", type=int, default=None, help="Season to simulate (defaults to ESPN season in .env).")
@click.option("--start-week", type=int, default=None, help="First week to include (defaults to next unplayed).")
@click.option("--end-week", type=int, default=None, help="Last week to include (defaults to last projection file).")
@click.option(
    "--sigma",
    type=float,
    default=DEFAULT_SIGMA,
    show_default=True,
    help="Point-spread standard deviation used for win probabilities.",
)
@click.option(
    "--simulations",
    type=int,
    default=DEFAULT_SIMULATIONS,
    show_default=True,
    help="Number of Monte Carlo iterations to run (0 disables).",
)
@click.option(
    "--playoff-slots",
    type=int,
    default=DEFAULT_PLAYOFF_SLOTS,
    show_default=True,
    help="Number of playoff seeds to treat as qualifiers during Monte Carlo runs.",
)
@click.option("--random-seed", type=int, default=None, help="Optional seed for Monte Carlo reproducibility.")
@click.option(
    "--scenario",
    type=str,
    default=None,
    help="Scenario overlay ID to apply (defaults to baseline).",
)
@click.option(
    "--output",
    type=click.Path(path_type=Path, dir_okay=False, writable=True),
    default=None,
    help="Optional explicit output JSON path.",
)
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def sim_rest_of_season(
    season: int | None,
    start_week: int | None,
    end_week: int | None,
    sigma: float,
    simulations: int,
    playoff_slots: int,
    random_seed: int | None,
    scenario: str | None,
    output: Path | None,
    env_file: Path,
) -> None:
    """Generate the rest-of-season deterministic simulation dataset."""

    settings = get_settings(env_file)
    target_season = season or settings.espn_season
    if target_season is None:
        raise click.BadParameter("Season must be provided via --season or ESPn season in .env")

    simulator = RestOfSeasonSimulator(settings)
    dataset = simulator.build_dataset(
        season=target_season,
        start_week=start_week,
        end_week=end_week,
        sigma=sigma,
        sim_iterations=simulations,
        playoff_slots=playoff_slots,
        random_seed=random_seed,
        scenario_id=scenario,
    )

    output_path = output or default_simulation_output(settings, target_season, scenario)
    path = simulator.write_dataset(dataset, output_path)
    mc = dataset.get("monte_carlo")
    sim_summary = ""
    if isinstance(mc, dict) and mc.get("iterations"):
        sim_summary = f", {mc['iterations']} sims"

    scenario_info = dataset.get("scenario")
    scenario_label = None
    scenario_identifier = None
    if isinstance(scenario_info, dict):
        scenario_label = scenario_info.get("label")
        scenario_identifier = scenario_info.get("id")
    if scenario_label and scenario_identifier:
        scenario_summary = f", scenario {scenario_identifier} ({scenario_label})"
    elif scenario_identifier:
        scenario_summary = f", scenario {scenario_identifier}"
    else:
        scenario_summary = ""

    click.echo(
        f"Rest-of-season simulation → {path} (weeks {dataset['start_week']}-{dataset['end_week']}{sim_summary}{scenario_summary})"
    )


@cli.command("refresh-all")
@click.option("--season", type=int, default=None, help="Season to refresh (defaults to ESPN season in .env).")
@click.option("--week", type=int, help="Single week to refresh (shorthand for --start-week/--end-week).")
@click.option("--start-week", type=int, help="First week to process when building projections.")
@click.option("--end-week", type=int, help="Last week to process; defaults to start week.")
@click.option("--lookback", type=int, default=3, show_default=True, help="Lookback window for usage baseline provider.")
@click.option("--provider", "providers", multiple=True, help="Projection providers in priority order (e.g. espn, usage).")
@click.option("--league-size", type=int, default=12, show_default=True, help="League size used for FantasyCalc pulls.")
@click.option("--ppr", type=float, default=1.0, show_default=True, help="PPR setting for FantasyCalc pulls.")
@click.option("--num-qbs", type=int, default=1, show_default=True, help="Number of starting QBs (use 2 for superflex).")
@click.option("--dynasty/--redraft", "is_dynasty", default=False, show_default=True, help="Pull dynasty instead of redraft values from FantasyCalc.")
@click.option("--include-adp", is_flag=True, help="Include ADP when fetching FantasyCalc rankings (if available).")
@click.option(
    "--config",
    "config_path",
    type=click.Path(path_type=Path, dir_okay=False, exists=True, readable=True),
    default=Path("config/scoring.yaml"),
    show_default=True,
    help="Scoring configuration file to use.",
)
@click.option("--force-nflverse", is_flag=True, help="Force re-download of nflverse datasets during refresh-week.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def refresh_all(
    season: int | None,
    week: int | None,
    start_week: int | None,
    end_week: int | None,
    lookback: int,
    providers: tuple[str, ...],
    league_size: int,
    ppr: float,
    num_qbs: int,
    is_dynasty: bool,
    include_adp: bool,
    config_path: Path,
    force_nflverse: bool,
    env_file: Path,
) -> None:
    """Run the full data refresh pipeline (ESPN + projections + FantasyCalc)."""

    if week is not None and (start_week is not None or end_week is not None):
        raise click.BadParameter("Use either --week or --start-week/--end-week, not both.")

    if lookback < 0:
        raise click.BadParameter("--lookback must be non-negative")

    settings = get_settings(env_file)
    target_season = season or settings.espn_season
    if target_season is None:
        raise click.BadParameter("Season must be provided via --season or ESPn season in .env")

    effective_start = week if week is not None else start_week
    effective_end = week if week is not None else end_week
    auto_end = end_week is None and week is None

    if effective_start is None:
        click.echo(f"[1/6] Refreshing ESPN data for season {target_season} (auto week)")
    else:
        if effective_end is not None and effective_end < effective_start:
            raise click.BadParameter("--end-week must be >= --start-week")
        click.echo(f"[1/6] Refreshing ESPN data for season {target_season}, week {effective_start}")

    refreshed_week = refresh_week.callback(
        season=target_season,
        week=effective_start,
        config_path=config_path,
        force_nflverse=force_nflverse,
        skip_score=False,
        env_file=env_file,
    )

    if effective_start is None:
        effective_start = refreshed_week
        effective_end = refreshed_week
        click.echo(f"  → Detected current week {effective_start} from ESPN")
    else:
        if refreshed_week is not None and refreshed_week != effective_start:
            click.echo(
                f"  → ESPN reported week {refreshed_week}; continuing with that week for projections"
            )
            effective_start = refreshed_week
            if effective_end is None or effective_end < refreshed_week:
                effective_end = refreshed_week

    if auto_end:
        simulator = RestOfSeasonSimulator(settings)
        projection_weeks = simulator._detect_projection_weeks(target_season)
        if projection_weeks:
            max_projection_week = max(projection_weeks)
            effective_end = max(max_projection_week, effective_start)
        else:
            effective_end = effective_start

    # Step 2: build projection baselines for the requested range
    provider_list = [name.strip().lower() for name in providers if name.strip()]
    if not provider_list:
        provider_list = [PROVIDER_ESPN, PROVIDER_USAGE]
    click.echo(f"[2/6] Building projection baselines for weeks {effective_start}-{effective_end} via {', '.join(provider_list)}")
    projections_baseline.callback(
        season=target_season,
        start_week=effective_start,
        end_week=effective_end,
        lookback=lookback,
        provider_names=tuple(provider_list),
        env_file=env_file,
    )

    # Step 3: score projections for the same window
    click.echo(f"[3/6] Scoring projections for weeks {effective_start}-{effective_end}")
    for wk in range(effective_start, effective_end + 1):
        projections_apply.callback(
            season=target_season,
            week=wk,
            baseline=None,
            overrides=None,
            assumptions=None,
            config_path=config_path,
            env_file=env_file,
        )

    # Step 4: fetch FantasyCalc trade values
    click.echo("[4/6] Fetching FantasyCalc trade values")
    calc_trade_chart.callback(
        season=target_season,
        league_size=league_size,
        ppr=ppr,
        num_qbs=num_qbs,
        is_dynasty=is_dynasty,
        output=None,
        env_file=env_file,
    )

    # Step 5: fetch FantasyCalc rankings
    click.echo("[5/6] Fetching FantasyCalc rankings")
    calc_redraft_rankings.callback(
        season=target_season,
        league_size=league_size,
        ppr=ppr,
        num_qbs=num_qbs,
        is_dynasty=is_dynasty,
        include_adp=include_adp,
        output=None,
        env_file=env_file,
    )

    click.echo("[6/6] Building rest-of-season simulation dataset")
    sim_rest_of_season.callback(
        season=target_season,
        start_week=effective_start,
        end_week=effective_end,
        sigma=DEFAULT_SIGMA,
        simulations=DEFAULT_SIMULATIONS,
        playoff_slots=DEFAULT_PLAYOFF_SLOTS,
        random_seed=None,
        scenario=None,
        output=None,
        env_file=env_file,
    )

    click.echo("Refresh complete.")


@calc.command("trade-chart")
@click.option("--season", type=int, default=None, help="Season directory for storing output (defaults to ESPN season in .env).")
@click.option("--league-size", type=int, default=12, show_default=True, help="Number of teams in the league.")
@click.option("--ppr", type=float, default=1.0, show_default=True, help="PPR setting (1 = full PPR).")
@click.option("--num-qbs", type=int, default=1, show_default=True, help="Number of starting QBs (use 2 for superflex).")
@click.option(
    "--dynasty/--redraft",
    "is_dynasty",
    default=False,
    show_default=True,
    help="Pull dynasty values instead of redraft.",
)
@click.option(
    "--output",
    type=click.Path(path_type=Path, dir_okay=False, writable=True),
    default=None,
    help="Optional explicit output CSV path.",
)
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def calc_trade_chart(
    season: int | None,
    league_size: int,
    ppr: float,
    num_qbs: int,
    is_dynasty: bool,
    output: Path | None,
    env_file: Path,
) -> None:
    """Download and store FantasyCalc trade values."""

    settings = get_settings(env_file)
    target_season = season or settings.espn_season or 0

    params = FantasyCalcParams(
        is_dynasty=is_dynasty,
        num_qbs=num_qbs,
        num_teams=league_size,
        ppr=ppr,
    )

    raw = fetch_trade_chart(params)
    rows = normalize_trade_chart(raw)

    if output is None:
        output_dir = settings.data_root / "out" / "fantasycalc" / str(target_season)
        output = output_dir / "trade_values.csv"

    path = write_csv(rows, output)
    click.echo(f"FantasyCalc trade values → {path} ({len(rows)} players)")


@calc.command("redraft-rankings")
@click.option("--season", type=int, default=None, help="Season directory for storing output (defaults to ESPN season in .env).")
@click.option("--league-size", type=int, default=12, show_default=True, help="Number of teams in the league.")
@click.option("--ppr", type=float, default=1.0, show_default=True, help="PPR setting (1 = full PPR).")
@click.option("--num-qbs", type=int, default=1, show_default=True, help="Number of starting QBs (use 2 for superflex).")
@click.option(
    "--dynasty/--redraft",
    "is_dynasty",
    default=False,
    show_default=True,
    help="Pull dynasty values instead of redraft.",
)
@click.option("--include-adp", is_flag=True, help="Include ADP data when available.")
@click.option(
    "--output",
    type=click.Path(path_type=Path, dir_okay=False, writable=True),
    default=None,
    help="Optional explicit output CSV path.",
)
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def calc_redraft_rankings(
    season: int | None,
    league_size: int,
    ppr: float,
    num_qbs: int,
    is_dynasty: bool,
    include_adp: bool,
    output: Path | None,
    env_file: Path,
) -> None:
    """Download and store FantasyCalc redraft (or dynasty) rankings."""

    settings = get_settings(env_file)
    target_season = season or settings.espn_season or 0

    params = FantasyCalcParams(
        is_dynasty=is_dynasty,
        num_qbs=num_qbs,
        num_teams=league_size,
        ppr=ppr,
    )

    raw = fetch_redraft_values(params, include_adp=include_adp)
    rows: list[dict[str, object]] = []
    for entry in raw:
        player = entry.get("player") or {}
        rows.append(
            {
                "player_id": player.get("id"),
                "player_name": player.get("name"),
                "position": player.get("position"),
                "team": player.get("maybeTeam"),
                "age": player.get("maybeAge"),
                "value": entry.get("value"),
                "value_redraft": entry.get("redraftValue"),
                "value_dynasty": entry.get("combinedValue"),
                "overall_rank": entry.get("overallRank"),
                "position_rank": entry.get("positionRank"),
                "trend_30_day": entry.get("trend30Day"),
                "trade_frequency": entry.get("maybeTradeFrequency"),
                "adp": entry.get("maybeAdp"),
            }
        )

    if output is None:
        output_dir = settings.data_root / "out" / "fantasycalc" / str(target_season)
        filename = "redraft_rankings.csv" if not is_dynasty else "dynasty_rankings.csv"
        output = output_dir / filename

    path = write_csv(rows, output)
    click.echo(f"FantasyCalc rankings → {path} ({len(rows)} players)")


@audit.command("week")
@click.option("--season", type=int, default=None, help="Season to audit (defaults to ESPn season in .env).")
@click.option("--week", type=int, required=True, help="Week number to audit.")
@click.option("--show-matches", is_flag=True, help="Display matching totals in addition to discrepancies.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def audit_week(season: int | None, week: int, show_matches: bool, env_file: Path) -> None:
    """Compare weekly outputs against ESPN snapshots and schedule totals."""

    settings = get_settings(env_file)
    target_season = season or settings.espn_season
    if target_season is None:
        raise click.BadParameter("Season must be provided via --season or ESPn season in .env")

    base_out = settings.data_root / "out" / "espn" / str(target_season)
    base_raw = settings.data_root / "raw" / "espn" / str(target_season)

    teams_path = base_out / "teams.csv"
    schedule_path = base_out / "schedule.csv"
    scores_path = base_out / f"weekly_scores_{target_season}_week_{week}.csv"
    snapshot_path = base_raw / f"view-mRoster-week-{week}.json"

    for path in (teams_path, schedule_path, scores_path, snapshot_path):
        if not path.exists():
            raise click.FileError(str(path), hint="Required artifact missing; run refresh/build first.")

    teams: dict[int, str] = {}
    with teams_path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            teams[int(row["team_id"])] = row["team_name"]

    scored_rows: list[dict[str, str]] = []
    with scores_path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("counts_for_score", "").lower() == "true":
                scored_rows.append(row)

    schedule_totals: dict[int, float] = {}
    with schedule_path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            if int(row.get("week", 0)) != week:
                continue
            schedule_totals[int(row["home_team_id"])] = float(row.get("home_points") or 0)
            schedule_totals[int(row["away_team_id"])] = float(row.get("away_points") or 0)

    snapshot = json.loads(snapshot_path.read_text())
    espn_applied: dict[int, float] = {}
    for team in snapshot.get("teams", []):
        for entry in team.get("roster", {}).get("entries", []):
            player = entry.get("playerPoolEntry", {}).get("player", {})
            pid = player.get("id")
            if pid is None:
                continue
            stats = player.get("stats", [])
            record = next(
                (
                    item
                    for item in stats
                    if item.get("scoringPeriodId") == week and item.get("statSourceId") == 0
                ),
                None,
            )
            if record is not None:
                espn_applied[int(pid)] = float(record.get("appliedTotal", 0.0))

    per_team: dict[int, float] = {}
    per_player_diff: dict[int, list[tuple[str, float, float, float]]] = {}
    for row in scored_rows:
        team_id = int(row["team_id"])
        total = float(row.get("score_total") or 0)
        per_team[team_id] = per_team.get(team_id, 0.0) + total

        pid_raw = row.get("espn_player_id")
        if not pid_raw:
            continue
        try:
            pid = int(float(pid_raw))
        except ValueError:
            continue
        espn_total = espn_applied.get(pid)
        if espn_total is None:
            continue
        diff = total - espn_total
        if abs(diff) > 1e-6:
            per_player_diff.setdefault(team_id, []).append((row["player_name"], total, espn_total, diff))

    click.echo(f"Audit results · season {target_season} · week {week}")
    click.echo("Player comparisons vs ESPN snapshot:")
    if per_player_diff:
        for team_id in sorted(per_player_diff):
            click.echo(f"  {teams.get(team_id, str(team_id))}:")
            for name, ours, espn_value, diff in per_player_diff[team_id]:
                click.echo(
                    f"    {name}: ours={ours:.2f} espn={espn_value:.2f} diff={diff:+.2f}"
                )
    else:
        click.echo("  All starters match ESPN applied totals")

    click.echo("\nTeam totals vs ESPN schedule:")
    for team_id in sorted(teams):
        if team_id not in schedule_totals:
            continue
        ours_total = per_team.get(team_id, 0.0)
        espn_total = schedule_totals[team_id]
        diff = round(ours_total - espn_total, 2)
        if diff != 0 or show_matches:
            click.echo(
                f"  {teams[team_id]}: ours={ours_total:.2f} espn={espn_total:.2f} diff={diff:+.2f}"
            )


@audit.command("transactions")
@click.option("--season", type=int, default=None, help="Season to audit (defaults to ESPN season in .env).")
@click.option(
    "--week",
    "weeks",
    type=int,
    multiple=True,
    help="Only include transactions affecting these scoring period ids (repeatable).",
)
@click.option(
    "--team",
    "team_filters",
    type=str,
    multiple=True,
    help="Filter to transactions involving these teams (id or name substring).",
)
@click.option(
    "--show-proposals",
    is_flag=True,
    help="Include pending/canceled trade proposals and other non-executed moves.",
)
@click.option("--limit", type=int, default=None, help="Maximum number of transactions to display.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def audit_transactions(
    season: int | None,
    weeks: tuple[int, ...],
    team_filters: tuple[str, ...],
    show_proposals: bool,
    limit: int | None,
    env_file: Path,
) -> None:
    """Display league transactions (trades, adds, drops) for review."""

    settings = get_settings(env_file)
    target_season = season or settings.espn_season
    if target_season is None:
        raise click.BadParameter("Season must be provided via --season or ESPN season in .env")

    base_out = settings.data_root / "out" / "espn" / str(target_season)
    transactions_path = base_out / "transactions.csv"
    items_path = base_out / "transaction_items.csv"
    teams_path = base_out / "teams.csv"

    for path in (transactions_path, items_path, teams_path):
        if not path.exists():
            raise click.FileError(str(path), hint="Run `fantasy refresh-week` first to build transactions data.")

    def _safe_int(value: str | None) -> int | None:
        if value is None or value == "":
            return None
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None

    def _parse_bool(value: str | None) -> bool | None:
        if value is None or value == "":
            return None
        lowered = value.lower()
        if lowered in {"true", "1", "yes"}:
            return True
        if lowered in {"false", "0", "no"}:
            return False
        return None

    def _parse_iso(value: str | None) -> datetime | None:
        if not value:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

    def _normalize_id(value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        if normalized.lower() == "nan":
            return None
        return normalized

    team_lookup: dict[int, str] = {}
    with teams_path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            team_id = _safe_int(row.get("team_id"))
            name = row.get("team_name")
            if team_id is not None and name:
                team_lookup[team_id] = name

    transactions: list[dict[str, object]] = []
    with transactions_path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            tx: dict[str, object] = dict(row)
            tx_id = _normalize_id(row.get("transaction_id"))
            tx["transaction_id"] = tx_id
            tx["team_id"] = _safe_int(row.get("team_id"))
            tx["team_name"] = row.get("team_name") or team_lookup.get(tx["team_id"])
            tx["scoring_period_id"] = _safe_int(row.get("scoring_period_id"))
            tx["is_pending"] = _parse_bool(row.get("is_pending"))
            tx["status"] = row.get("status") or ""
            tx["type"] = row.get("type") or ""
            tx["executed_date"] = row.get("executed_date") or ""
            tx["proposed_date"] = row.get("proposed_date") or ""
            tx["_executed_dt"] = _parse_iso(tx["executed_date"]) or _parse_iso(tx["proposed_date"])
            transactions.append(tx)

    items_by_tx: dict[str, list[dict[str, object]]] = defaultdict(list)
    with items_path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            tid = _normalize_id(row.get("transaction_id"))
            if tid is None:
                continue
            item: dict[str, object] = dict(row)
            item["transaction_id"] = tid
            item["player_id"] = _safe_int(row.get("player_id"))
            item["from_team_id"] = _safe_int(row.get("from_team_id"))
            item["to_team_id"] = _safe_int(row.get("to_team_id"))
            item["waiver_order"] = _safe_int(row.get("waiver_order"))
            item["scoring_period_id"] = _safe_int(row.get("scoring_period_id"))
            item["is_pending"] = _parse_bool(row.get("is_pending"))
            item["bid_amount"] = row.get("bid_amount")
            from_name = team_lookup.get(item["from_team_id"])
            to_name = team_lookup.get(item["to_team_id"])
            if from_name:
                item["from_team_name"] = from_name
            if to_name:
                item["to_team_name"] = to_name
            items_by_tx[tid].append(item)

    week_filters = {week for week in weeks if week is not None}
    numeric_team_filters: set[int] = set()
    text_team_filters: list[str] = []
    for raw in team_filters:
        candidate = raw.strip()
        if not candidate:
            continue
        num_val = _safe_int(candidate)
        if num_val is not None:
            numeric_team_filters.add(num_val)
            continue
        text_team_filters.append(candidate.lower())

    filtered: list[dict[str, object]] = []
    for tx in transactions:
        status = (tx.get("status") or "").upper()
        if not show_proposals and status != "EXECUTED":
            continue

        tid = tx.get("transaction_id")
        tx_items = items_by_tx.get(tid or "", [])

        if week_filters:
            candidate_weeks: set[int] = set()
            tx_week = tx.get("scoring_period_id")
            if isinstance(tx_week, int):
                candidate_weeks.add(tx_week)
            for item in tx_items:
                item_week = item.get("scoring_period_id")
                if isinstance(item_week, int):
                    candidate_weeks.add(item_week)
            if not candidate_weeks & week_filters:
                continue

        if numeric_team_filters or text_team_filters:
            candidate_ids: set[int] = set()
            candidate_names: set[str] = set()

            team_id = tx.get("team_id")
            team_name = tx.get("team_name")
            if isinstance(team_id, int):
                candidate_ids.add(team_id)
                lookup_name = team_lookup.get(team_id)
                if lookup_name:
                    candidate_names.add(lookup_name.lower())
            if isinstance(team_name, str) and team_name:
                candidate_names.add(team_name.lower())

            for item in tx_items:
                for key in ("from_team_id", "to_team_id"):
                    t_id = item.get(key)
                    if isinstance(t_id, int):
                        candidate_ids.add(t_id)
                        lookup_name = team_lookup.get(t_id)
                        if lookup_name:
                            candidate_names.add(lookup_name.lower())

            team_match = False
            if numeric_team_filters & candidate_ids:
                team_match = True
            else:
                for needle in text_team_filters:
                    if any(needle in name for name in candidate_names):
                        team_match = True
                        break
            if not team_match:
                continue

        tx["_items"] = tx_items
        filtered.append(tx)

    fallback_datetime = datetime.min.replace(tzinfo=timezone.utc)
    filtered.sort(
        key=lambda row: (
            row.get("_executed_dt") or fallback_datetime,
            row.get("transaction_id") or "",
        ),
        reverse=True,
    )

    if limit is not None and limit > 0:
        filtered = filtered[:limit]

    click.echo(f"Audit transactions · season {target_season}")
    if week_filters:
        click.echo(f"  Weeks: {', '.join(str(w) for w in sorted(week_filters))}")
    if numeric_team_filters or text_team_filters:
        click.echo(
            "  Teams: "
            + ", ".join(sorted({*map(str, numeric_team_filters), *team_filters}))
        )
    if not filtered:
        click.echo("  No transactions found for supplied filters.")
        return

    for tx in filtered:
        executed = tx.get("executed_date") or tx.get("proposed_date") or "-"
        tx_week = tx.get("scoring_period_id")
        if not isinstance(tx_week, int):
            for item in tx.get("_items", []):
                item_week = item.get("scoring_period_id")
                if isinstance(item_week, int):
                    tx_week = item_week
                    break
        header = (
            f"{executed} | week {tx_week if tx_week is not None else '-'} | "
            f"{(tx.get('type') or '').upper()} ({(tx.get('status') or '').upper()})"
        )
        team_id = tx.get("team_id")
        team_name = tx.get("team_name")
        if isinstance(team_id, int) or (isinstance(team_name, str) and team_name):
            resolved_name = team_name or team_lookup.get(team_id)
            if resolved_name:
                header += f" · initiated by {resolved_name}"
            elif team_id is not None:
                header += f" · team {team_id}"

        click.echo(header)

        for item in tx.get("_items", []):
            item_type = (item.get("item_type") or "").upper()
            player_name = item.get("player_name") or item.get("player_id") or "Unknown player"
            from_name = item.get("from_team_name") or item.get("from_team_id")
            to_name = item.get("to_team_name") or item.get("to_team_id")

            prefix = {
                "ADD": "+",
                "DROP": "-",
                "TRADE": "⇄",
                "MOVE": "⇆",
            }.get(item_type, item_type or "·")

            detail_parts = [f"{player_name}"]
            if item_type == "ADD":
                destination = to_name if to_name is not None else "destination"
                origin = from_name if from_name is not None else "pool"
                detail_parts.append(f"→ {destination} (from {origin})")
            elif item_type == "DROP":
                origin = from_name if from_name is not None else "team"
                detail_parts.append(f"from {origin}")
            elif item_type in {"TRADE", "MOVE"}:
                detail_parts.append(f"{from_name} → {to_name}")
            else:
                if to_name is not None or from_name is not None:
                    detail_parts.append(f"{from_name} → {to_name}")

            bid_amount = item.get("bid_amount")
            if bid_amount not in (None, "", "nan"):
                detail_parts.append(f"bid {bid_amount}")

            waiver_order = item.get("waiver_order")
            if isinstance(waiver_order, int):
                detail_parts.append(f"waiver #{waiver_order}")

            item_week = item.get("scoring_period_id")
            if isinstance(item_week, int) and item_week != tx_week:
                detail_parts.append(f"wk {item_week}")

            lineup_slot = item.get("lineup_slot")
            if lineup_slot not in (None, "", "nan"):
                detail_parts.append(f"slot {lineup_slot}")

            click.echo(f"  {prefix} {' · '.join(str(part) for part in detail_parts if part)}")

        click.echo("")


@projections.command("apply")
@click.option("--season", type=int, default=None, help="Season to build projections for (defaults to ESPN season in .env).")
@click.option("--week", type=int, required=True, help="Week to project.")
@click.option(
    "--baseline",
    type=click.Path(path_type=Path, dir_okay=False, readable=True),
    default=None,
    help="Path to baseline projections CSV (defaults to data/in/projections/<season>/baseline_week_<week>.csv).",
)
@click.option(
    "--overrides",
    type=click.Path(path_type=Path, dir_okay=False, readable=True),
    default=None,
    help="Optional manual override CSV (season/week/player rows with replacement values).",
)
@click.option(
    "--assumptions",
    type=click.Path(path_type=Path, dir_okay=False, exists=False),
    default=Path("config/projections.yaml"),
    show_default=True,
    help="YAML file describing global/positional multipliers and additions.",
)
@click.option(
    "--config",
    "config_path",
    type=click.Path(path_type=Path, dir_okay=False, readable=True),
    default=Path("config/scoring.yaml"),
    show_default=True,
    help="Scoring config used to convert stat projections into fantasy points.",
)
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def projections_apply(
    season: int | None,
    week: int,
    baseline: Path | None,
    overrides: Path | None,
    assumptions: Path | None,
    config_path: Path,
    env_file: Path,
) -> None:
    """Combine baseline projections, overrides, and assumptions into a scored dataset."""

    settings = get_settings(env_file)
    target_season = season or settings.espn_season
    if target_season is None:
        raise click.BadParameter("Season must be provided via --season or ESPN season in .env")

    base_dir = settings.data_root / "in" / "projections" / str(target_season)
    baseline_path = baseline or (base_dir / f"baseline_week_{week}.csv")

    overrides_path = overrides or (base_dir / "manual_overrides.csv")
    if overrides is None and not overrides_path.exists():
        overrides_path = None

    assumptions_path = assumptions if assumptions is not None else None
    if assumptions_path is not None and not assumptions_path.exists():
        assumptions_path = None

    scoring_config = ScoringConfig.load(config_path)
    manager = ProjectionManager(settings, scoring_config)

    output_dir = settings.data_root / "out" / "projections" / str(target_season)
    output_path = output_dir / f"projected_stats_week_{week}.csv"

    result = manager.build_week_projection(
        target_season,
        week,
        Path(baseline_path),
        overrides_path,
        assumptions_path,
        output_path,
    )

    click.echo(
        f"Projections → {output_path} ({len(result)} players; projected column = projected_points)"
    )


@projections.command("baseline")
@click.option("--season", type=int, default=None, help="Season to build baselines for (defaults to ESPN season in .env).")
@click.option("--start-week", type=int, required=True, help="First week to project.")
@click.option(
    "--end-week",
    type=int,
    default=None,
    help="Last week to project (defaults to start week).",
)
@click.option(
    "--lookback",
    type=int,
    default=3,
    show_default=True,
    help="Number of past weeks to average when building baselines.",
)
@click.option(
    "--provider",
    "provider_names",
    multiple=True,
    help="Projection provider(s) in priority order (e.g. espn, usage).",
)
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def projections_baseline(
    season: int | None,
    start_week: int,
    end_week: int | None,
    lookback: int,
    provider_names: tuple[str, ...],
    env_file: Path,
) -> None:
    """Generate baseline stat projections from historical usage."""

    settings = get_settings(env_file)
    target_season = season or settings.espn_season
    if target_season is None:
        raise click.BadParameter("Season must be provided via --season or ESPN season in .env")

    final_week = end_week or start_week
    if final_week < start_week:
        raise click.BadParameter("--end-week must be >= --start-week")
    if lookback < 0:
        raise click.BadParameter("--lookback must be non-negative")

    providers: list[str] = [name.strip().lower() for name in provider_names if name.strip()]
    if not providers:
        providers = [PROVIDER_ESPN, PROVIDER_USAGE]

    output_dir = settings.data_root / "in" / "projections" / str(target_season)
    output_dir.mkdir(parents=True, exist_ok=True)

    for week in range(start_week, final_week + 1):
        df = build_projection_baseline(settings, target_season, week, providers, lookback)
        path = output_dir / f"baseline_week_{week}.csv"
        df.to_csv(path, index=False)
        click.echo(f"Baseline week {week} → {path} ({len(df)} players)")


@scenario.command("create")
@click.option("--season", type=int, default=None, help="Season for the scenario (defaults to ESPN season in .env).")
@click.option("--id", "scenario_id", required=True, help="Unique scenario identifier (file name).")
@click.option("--label", type=str, default=None, help="Human-friendly label for the scenario.")
@click.option("--description", type=str, default=None, help="Optional description stored with the overlay.")
@click.option(
    "--copy-completed",
    "copy_completed",
    type=int,
    multiple=True,
    help="Completed week number to seed from baseline data (repeatable).",
)
@click.option(
    "--copy-projection",
    "copy_projection",
    type=int,
    multiple=True,
    help="Projection week number to seed from baseline projections (repeatable).",
)
@click.option("--empty-completed", is_flag=True, help="Create an empty completed-weeks section (no baseline copy).")
@click.option("--empty-projections", is_flag=True, help="Create an empty projection-weeks section (no baseline copy).")
@click.option("--overwrite", is_flag=True, help="Overwrite the overlay file if it already exists.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def scenario_create(
    season: int | None,
    scenario_id: str,
    label: str | None,
    description: str | None,
    copy_completed: tuple[int, ...],
    copy_projection: tuple[int, ...],
    empty_completed: bool,
    empty_projections: bool,
    overwrite: bool,
    env_file: Path,
) -> None:
    """Create a scenario overlay JSON, optionally seeding data from baseline outputs."""

    settings = get_settings(env_file)
    target_season = _resolve_target_season(settings, season)

    if scenario_id == BASELINE_SCENARIO_ID:
        raise click.BadParameter("Scenario id 'baseline' is reserved; choose a different id.")

    if (
        not copy_completed
        and not copy_projection
        and not empty_completed
        and not empty_projections
    ):
        raise click.UsageError(
            "Specify --copy-completed/--copy-projection to seed data or use --empty-* flags for a blank overlay."
        )

    overlay_dir = settings.data_root / "overlays" / str(target_season)
    overlay_dir.mkdir(parents=True, exist_ok=True)
    overlay_path = overlay_dir / f"{scenario_id}.json"

    if overlay_path.exists() and not overwrite:
        raise click.ClickException(
            f"Overlay already exists: {overlay_path}. Use --overwrite to replace it."
        )

    payload: dict[str, object] = {
        "scenario_id": scenario_id,
        "season": target_season,
        "label": label or scenario_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if description:
        payload["description"] = description

    completed_section: dict[str, object] = {}
    if not empty_completed:
        for week in sorted(set(copy_completed)):
            try:
                week_payload = _load_weekly_scores_for_overlay(settings, target_season, week)
            except FileNotFoundError as exc:
                raise click.ClickException(str(exc)) from exc
            matchups_payload = _load_matchups_for_overlay(settings, target_season, week)
            week_payload.update(matchups_payload)
            completed_section[str(week)] = week_payload
    if completed_section or empty_completed:
        payload["completed_weeks"] = completed_section

    projection_section: dict[str, object] = {}
    if not empty_projections:
        for week in sorted(set(copy_projection)):
            try:
                projection_section[str(week)] = _load_projection_week_for_overlay(
                    settings, target_season, week
                )
            except FileNotFoundError as exc:
                raise click.ClickException(str(exc)) from exc
    if projection_section or empty_projections:
        payload["projection_weeks"] = projection_section

    overlay_path.write_text(json.dumps(payload, indent=2) + "\n")
    click.echo(f"Scenario overlay → {overlay_path}")


@scenario.command("describe")
@click.option("--season", type=int, default=None, help="Season of the scenario (defaults to ESPN season in .env).")
@click.option("--id", "scenario_id", required=True, help="Scenario identifier to describe.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def scenario_describe(season: int | None, scenario_id: str, env_file: Path) -> None:
    """Print a summary of a scenario overlay."""

    settings = get_settings(env_file)
    target_season = _resolve_target_season(settings, season)

    store = OverlayStore(settings.data_root)
    overlay = store.load_overlay(target_season, scenario_id)

    if overlay.metadata.path is None or not overlay.metadata.path.exists():
        if scenario_id == BASELINE_SCENARIO_ID:
            click.echo("Baseline scenario (no overlay file).")
            return
        raise click.ClickException(
            f"No overlay found for scenario '{scenario_id}' in season {target_season}."
        )

    click.echo(f"Scenario: {overlay.metadata.scenario_id}")
    click.echo(f"Season:   {overlay.metadata.season}")
    click.echo(f"Label:    {overlay.metadata.label or overlay.metadata.scenario_id}")
    if overlay.metadata.description:
        click.echo(f"Notes:    {overlay.metadata.description}")
    click.echo(f"File:     {overlay.metadata.path}")
    if overlay.metadata.updated_at:
        click.echo(f"Updated:  {overlay.metadata.updated_at}")

    def _summarize_team_counts(week_overrides: dict[int, object]) -> str:
        summaries: list[str] = []
        for week in sorted(week_overrides.keys()):
            payload = week_overrides[week]
            if isinstance(payload, CompletedWeekOverride):
                team_count = len(payload.team_lineups)
            elif isinstance(payload, ProjectionWeekOverride):
                team_count = len(payload.team_lineups)
            elif isinstance(payload, dict):
                teams_data = payload.get("team_lineups") or payload.get("teams") or {}
                team_count = len(teams_data) if isinstance(teams_data, dict) else 0
            else:
                team_count = 0
            summaries.append(f"week {week} ({team_count} teams)")
        return ", ".join(summaries) if summaries else "none"

    completed_summary = _summarize_team_counts({k: v for k, v in overlay.completed_weeks.items()})
    projection_summary = _summarize_team_counts({k: v for k, v in overlay.projection_weeks.items()})

    click.echo(f"Completed weeks:  {completed_summary}")
    if overlay.completed_weeks:
        for week in sorted(overlay.completed_weeks):
            week_override = overlay.completed_weeks[week]
            team_count = len(week_override.team_lineups)
            matchup_count = len(week_override.matchup_overrides)
            click.echo(f"  • Week {week}: {team_count} teams, {matchup_count} matchups")

    click.echo(f"Projection weeks: {projection_summary}")
    if overlay.projection_weeks:
        for week in sorted(overlay.projection_weeks):
            week_override = overlay.projection_weeks[week]
            team_count = len(week_override.team_lineups)
            click.echo(f"  • Week {week}: {team_count} teams")


@scenario.command("set-score")
@click.option("--season", type=int, default=None, help="Season of the scenario (defaults to ESPN season in .env).")
@click.option("--id", "scenario_id", required=True, help="Scenario identifier to modify.")
@click.option("--week", type=int, required=True, help="Completed week to update.")
@click.option("--matchup", "matchup_id", required=True, help="Matchup identifier to update.")
@click.option("--home-team", type=int, default=None, help="Home team id (optional if already in data).")
@click.option("--away-team", type=int, default=None, help="Away team id (optional if already in data).")
@click.option("--home-points", type=float, default=None, help="Home team score total.")
@click.option("--away-points", type=float, default=None, help="Away team score total.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def scenario_set_score(
    season: int | None,
    scenario_id: str,
    week: int,
    matchup_id: str,
    home_team: int | None,
    away_team: int | None,
    home_points: float | None,
    away_points: float | None,
    env_file: Path,
) -> None:
    """Update a completed-week matchup score (and team totals) inside a scenario."""

    if scenario_id == BASELINE_SCENARIO_ID:
        raise click.BadParameter("Cannot edit the baseline scenario.")

    settings = get_settings(env_file)
    target_season = _resolve_target_season(settings, season)

    overlay_path, document = _load_overlay_document(settings, target_season, scenario_id)

    week_payload = _ensure_week_section(document, "completed_weeks", week)
    matchups = week_payload.setdefault("matchups", {})
    if not isinstance(matchups, dict):
        raise click.ClickException("Scenario payload has unexpected matchup data.")

    matchup_key = str(matchup_id)
    matchup_entry = matchups.get(matchup_key, {})
    if not isinstance(matchup_entry, dict):
        matchup_entry = {}

    baseline_matchups = _load_matchups_for_overlay(settings, target_season, week).get("matchups", {})
    baseline_entry = baseline_matchups.get(matchup_key, {}) if isinstance(baseline_matchups, dict) else {}

    if home_team is None:
        home_team = matchup_entry.get("home_team_id") or baseline_entry.get("home_team_id")
    if away_team is None:
        away_team = matchup_entry.get("away_team_id") or baseline_entry.get("away_team_id")

    if home_team is None or away_team is None:
        raise click.ClickException("Home/Away team ids are required (pass --home-team/--away-team).")

    if home_points is not None:
        matchup_entry["home_points"] = float(home_points)
    if away_points is not None:
        matchup_entry["away_points"] = float(away_points)

    matchup_entry["home_team_id"] = int(home_team)
    matchup_entry["away_team_id"] = int(away_team)

    if home_points is not None and away_points is not None:
        if abs(home_points - away_points) < 1e-6:
            matchup_entry["winner"] = "TIE"
        elif home_points > away_points:
            matchup_entry["winner"] = "HOME"
        else:
            matchup_entry["winner"] = "AWAY"

    matchups[matchup_key] = matchup_entry

    if home_points is not None:
        entries_home = _ensure_team_entries(week_payload, int(home_team), "score_total")
        _set_team_total(entries_home, "score_total", home_points)
        total_home = _total_with_override(entries_home, "score_total")
        _update_matchup_totals(week_payload, int(home_team), total=total_home)
    if away_points is not None:
        entries_away = _ensure_team_entries(week_payload, int(away_team), "score_total")
        _set_team_total(entries_away, "score_total", away_points)
        total_away = _total_with_override(entries_away, "score_total")
        _update_matchup_totals(week_payload, int(away_team), total=total_away)

    _write_overlay_document(overlay_path, document)
    click.echo(
        f"Updated matchup {matchup_key} (week {week}) in {overlay_path}"
    )


@scenario.command("set-player-score")
@click.option("--season", type=int, default=None, help="Season of the scenario (defaults to ESPN season in .env).")
@click.option("--id", "scenario_id", required=True, help="Scenario identifier to modify.")
@click.option("--week", type=int, required=True, help="Completed week to update.")
@click.option("--team", "team_id", type=int, required=True, help="Team id to update.")
@click.option("--player-id", type=int, default=None, help="ESPN player id to update or create.")
@click.option("--player-name", type=str, default=None, help="Player name when adding a new entry or matching without id.")
@click.option("--lineup-slot", type=str, default=None, help="Lineup slot to record (e.g. QB, RB).")
@click.option("--position", "espn_position", type=str, default=None, help="Position label (e.g. QB, RB).")
@click.option("--points", type=float, default=None, help="Optional explicit fantasy total to set after applying stats.")
@click.option(
    "--stat",
    "stat_pairs",
    multiple=True,
    help="Stat override in key=value form (repeat for multiple stats).",
)
@click.option(
    "--counts-for-score/--counts-for-bench",
    default=None,
    show_default=True,
    help="Whether the entry counts toward the team total.",
)
@click.option(
    "--config",
    "config_path",
    type=click.Path(path_type=Path, dir_okay=False, exists=True, readable=True),
    default=Path("config/scoring.yaml"),
    show_default=True,
    help="Scoring configuration file to use.",
)
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def scenario_set_player_score(
    season: int | None,
    scenario_id: str,
    week: int,
    team_id: int,
    player_id: int | None,
    player_name: str | None,
    lineup_slot: str | None,
    espn_position: str | None,
    points: float | None,
    stat_pairs: tuple[str, ...],
    counts_for_score: bool | None,
    config_path: Path,
    env_file: Path,
) -> None:
    """Update or insert a player's score within a completed week, optionally via stat overrides."""

    if player_id is None and not player_name:
        raise click.BadParameter("Provide --player-id or --player-name to identify the player.")

    settings = get_settings(env_file)
    target_season = _resolve_target_season(settings, season)

    overlay_path, document = _load_overlay_document(settings, target_season, scenario_id)

    week_payload = _ensure_week_section(document, "completed_weeks", week)
    entries = _ensure_team_entries(week_payload, team_id, "score_total")

    stats_override = _parse_stat_pairs(stat_pairs)

    baseline_df = _load_weekly_scores_df(settings, target_season, week)
    baseline_row = _locate_player_row(baseline_df, player_id, player_name)

    entry = _find_player_entry(entries, player_id=player_id, player_name=player_name)
    if entry is None:
        entry = {}
        entries.append(entry)

    # Merge baseline data with any existing overrides, then apply updates
    merged_row = baseline_row.copy()
    merged_row.update(entry)

    if player_id is not None:
        merged_row["espn_player_id"] = player_id
    if player_name:
        merged_row["player_name"] = player_name
    if lineup_slot:
        merged_row["lineup_slot"] = lineup_slot
    if espn_position:
        merged_row["espn_position"] = espn_position
    for key, value in stats_override.items():
        merged_row[key] = value

    config = ScoringConfig.load(config_path)
    engine = ScoreEngine(settings, config)
    scored_row = engine.score_dataframe(pd.DataFrame([merged_row])).iloc[0].to_dict()

    # Update entry fields
    for key in merged_row.keys():
        if key not in {"score_base", "score_bonus", "score_position", "score_total"}:
            entry[key] = merged_row[key]
    for key in ("score_base", "score_bonus", "score_position", "fantasy_points"):
        if key in scored_row:
            entry[key] = float(scored_row[key])

    auto_points = float(scored_row.get("score_total", merged_row.get("score_total", 0.0)))
    entry["score_total"] = float(points) if points is not None else auto_points

    effective_counts = counts_for_score
    if effective_counts is None:
        effective_counts = bool(scored_row.get("counts_for_score", entry.get("counts_for_score", True)))
    entry["counts_for_score"] = effective_counts
    entry["fantasy_points"] = entry["score_total"] if effective_counts else 0.0

    # Ensure stats override values persist for diff display
    for key, value in stats_override.items():
        entry[key] = value

    team_total = _total_with_override(entries, "score_total")
    _set_team_total(entries, "score_total", team_total)
    _update_matchup_totals(week_payload, team_id, total=team_total)

    _write_overlay_document(overlay_path, document)
    click.echo(
        f"Updated player {entry.get('player_name', player_id)} in week {week} (team {team_id})"
    )


@scenario.command("set-player-projection")
@click.option("--season", type=int, default=None, help="Season of the scenario (defaults to ESPN season in .env).")
@click.option("--id", "scenario_id", required=True, help="Scenario identifier to modify.")
@click.option("--week", type=int, required=True, help="Projection week to update.")
@click.option("--team", "team_id", type=int, required=True, help="Team id to update.")
@click.option("--player-id", type=int, default=None, help="ESPN player id to update or create.")
@click.option("--player-name", type=str, default=None, help="Player name when adding a new entry or matching without id.")
@click.option("--lineup-slot", type=str, default=None, help="Lineup slot to record (e.g. QB, RB).")
@click.option("--position", "espn_position", type=str, default=None, help="Position label (e.g. QB, RB).")
@click.option("--points", type=float, default=None, help="Optional explicit projected total after applying stats.")
@click.option("--stat", "stat_pairs", multiple=True, help="Projected stat override in key=value form (repeat for multiple stats).")
@click.option("--counts-for-score/--counts-for-bench", default=None, show_default=True, help="Whether the entry counts toward the team total.")
@click.option("--config", "config_path", type=click.Path(path_type=Path, dir_okay=False, exists=True, readable=True), default=Path("config/scoring.yaml"), show_default=True, help="Scoring configuration file to use.")
@click.option("--env-file", type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True), default=".env", show_default=True, help="Path to the .env file to load.")
def scenario_set_player_projection(
    season: int | None,
    scenario_id: str,
    week: int,
    team_id: int,
    player_id: int | None,
    player_name: str | None,
    lineup_slot: str | None,
    espn_position: str | None,
    points: float | None,
    stat_pairs: tuple[str, ...],
    counts_for_score: bool | None,
    config_path: Path,
    env_file: Path,
) -> None:
    """Update or insert a player's projection for a future week, optionally via stat overrides."""

    if player_id is None and not player_name:
        raise click.BadParameter("Provide --player-id or --player-name to identify the player.")

    settings = get_settings(env_file)
    target_season = _resolve_target_season(settings, season)

    overlay_path, document = _load_overlay_document(settings, target_season, scenario_id)

    week_payload = _ensure_week_section(document, "projection_weeks", week)
    entries = _ensure_team_entries(week_payload, team_id, "projected_points")

    stats_override = _parse_stat_pairs(stat_pairs)

    baseline_df = _load_projection_df(settings, target_season, week)
    baseline_row = _locate_projection_row(baseline_df, player_id, player_name)

    entry = _find_player_entry(entries, player_id=player_id, player_name=player_name)
    if entry is None:
        entry = {}
        entries.append(entry)

    merged_row = baseline_row.copy()
    merged_row.update(entry)

    if player_id is not None:
        merged_row["espn_player_id"] = player_id
    if player_name:
        merged_row["player_name"] = player_name
    if lineup_slot:
        merged_row["lineup_slot"] = lineup_slot
    if espn_position:
        merged_row["espn_position"] = espn_position
    for key, value in stats_override.items():
        merged_row[key] = value

    config = ScoringConfig.load(config_path)
    engine = ScoreEngine(settings, config)
    scored_row = engine.score_dataframe(pd.DataFrame([merged_row])).iloc[0].to_dict()

    for key in merged_row.keys():
        if key not in {"projected_points", "score_total", "score_base", "score_bonus", "score_position"}:
            entry[key] = merged_row[key]
    for key in ("score_base", "score_bonus", "score_position"):
        if key in scored_row:
            entry[key] = float(scored_row[key])

    auto_points = float(scored_row.get("score_total", merged_row.get("projected_points", 0.0)))
    entry["projected_points"] = float(points) if points is not None else auto_points
    entry["score_total"] = entry["projected_points"]

    effective_counts = counts_for_score
    if effective_counts is None:
        effective_counts = bool(scored_row.get("counts_for_score", entry.get("counts_for_score", True)))
    entry["counts_for_score"] = effective_counts

    for key, value in stats_override.items():
        entry[key] = value

    team_total = _total_with_override(entries, "projected_points")
    _set_team_total(entries, "projected_points", team_total)

    _write_overlay_document(overlay_path, document)
    click.echo(
        f"Updated projection for player {entry.get('player_name', player_id)} in week {week} (team {team_id})"
    )


@scenario.command("set-projection")

@click.option("--season", type=int, default=None, help="Season of the scenario (defaults to ESPN season in .env).")
@click.option("--id", "scenario_id", required=True, help="Scenario identifier to modify.")
@click.option("--week", type=int, required=True, help="Projection week to update.")
@click.option("--team", "team_id", type=int, required=True, help="Team id to update.")
@click.option("--points", type=float, required=True, help="Projected points to set for the team.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def scenario_set_projection(
    season: int | None,
    scenario_id: str,
    week: int,
    team_id: int,
    points: float,
    env_file: Path,
) -> None:
    """Update projected points for a team in a scenario."""

    if scenario_id == BASELINE_SCENARIO_ID:
        raise click.BadParameter("Cannot edit the baseline scenario.")

    settings = get_settings(env_file)
    target_season = _resolve_target_season(settings, season)

    overlay_path, document = _load_overlay_document(settings, target_season, scenario_id)

    week_payload = _ensure_week_section(document, "projection_weeks", week)
    entries = _ensure_team_entries(week_payload, team_id, "projected_points")
    _set_team_total(entries, "projected_points", points)

    _write_overlay_document(overlay_path, document)
    click.echo(
        f"Updated projection for team {team_id} in week {week} ({overlay_path})"
    )


@scenario.command("diff")
@click.option("--season", type=int, default=None, help="Season of the scenario (defaults to ESPN season in .env).")
@click.option("--id", "scenario_id", required=True, help="Scenario identifier to compare.")
@click.option(
    "--env-file",
    type=click.Path(path_type=Path, dir_okay=False, exists=False, readable=True),
    default=".env",
    show_default=True,
    help="Path to the .env file to load.",
)
def scenario_diff(season: int | None, scenario_id: str, env_file: Path) -> None:
    """Show differences between a scenario overlay and baseline data."""

    settings = get_settings(env_file)
    target_season = _resolve_target_season(settings, season)

    store = OverlayStore(settings.data_root)
    overlay = store.load_overlay(target_season, scenario_id)

    click.echo(f"Scenario: {overlay.metadata.scenario_id} (season {target_season})")

    changes_found = False

    if overlay.completed_weeks:
        click.echo("Completed weeks:")
        for week in sorted(overlay.completed_weeks):
            week_override = overlay.completed_weeks[week]
            try:
                baseline_week = _load_weekly_scores_for_overlay(settings, target_season, week)
                baseline_matchups = _load_matchups_for_overlay(settings, target_season, week)
            except FileNotFoundError:
                baseline_week = {"teams": {}}
                baseline_matchups = {"matchups": {}}

            lines: list[str] = []
            for team_id in sorted(week_override.team_lineups):
                lineup = week_override.team_lineups[team_id]
                overlay_total = _total_with_override(lineup.entries, "score_total")
                baseline_total = _baseline_team_total(baseline_week, team_id, "score_total")
                if abs(overlay_total - baseline_total) > 1e-6:
                    delta = overlay_total - baseline_total
                    lines.append(
                        f"    Team {team_id}: {baseline_total:.1f} → {overlay_total:.1f} ({delta:+.1f})"
                    )

            baseline_matchups_map = (
                baseline_matchups.get("matchups", {}) if isinstance(baseline_matchups, dict) else {}
            )
            for matchup_id in sorted(week_override.matchup_overrides):
                override_entry = week_override.matchup_overrides[matchup_id]
                baseline_entry = (
                    baseline_matchups_map.get(str(matchup_id))
                    if isinstance(baseline_matchups_map, dict)
                    else None
                ) or {}

                base_home = float(baseline_entry.get("home_points", 0.0) or 0.0)
                base_away = float(baseline_entry.get("away_points", 0.0) or 0.0)
                overlay_home = float(override_entry.get("home_points", base_home) or base_home)
                overlay_away = float(override_entry.get("away_points", base_away) or base_away)
                base_winner = (baseline_entry.get("winner") or "").upper()
                overlay_winner = (override_entry.get("winner") or base_winner).upper()

                if (
                    abs(overlay_home - base_home) > 1e-6
                    or abs(overlay_away - base_away) > 1e-6
                    or overlay_winner != base_winner
                ):
                    lines.append(
                        "    Matchup {mid}: home {bh:.1f} → {oh:.1f}, away {ba:.1f} → {oa:.1f}, winner {bw} → {ow}".format(
                            mid=matchup_id,
                            bh=base_home,
                            oh=overlay_home,
                            ba=base_away,
                            oa=overlay_away,
                            bw=base_winner or "-",
                            ow=overlay_winner or "-",
                        )
                    )

            if lines:
                changes_found = True
                click.echo(f"  Week {week}:")
                for line in lines:
                    click.echo(line)
            else:
                click.echo(f"  Week {week}: no differences")
    else:
        click.echo("Completed weeks: none")

    if overlay.projection_weeks:
        click.echo("Projection weeks:")
        for week in sorted(overlay.projection_weeks):
            week_override = overlay.projection_weeks[week]
            try:
                baseline_week = _load_projection_week_for_overlay(settings, target_season, week)
            except FileNotFoundError:
                baseline_week = {"teams": {}}

            lines: list[str] = []
            for team_id in sorted(week_override.team_lineups):
                lineup = week_override.team_lineups[team_id]
                overlay_total = _total_with_override(lineup.entries, "projected_points")
                baseline_total = _baseline_team_total(baseline_week, team_id, "projected_points")
                if abs(overlay_total - baseline_total) > 1e-6:
                    delta = overlay_total - baseline_total
                    lines.append(
                        f"    Team {team_id}: {baseline_total:.1f} → {overlay_total:.1f} ({delta:+.1f})"
                    )

            if lines:
                changes_found = True
                click.echo(f"  Week {week}:")
                for line in lines:
                    click.echo(line)
            else:
                click.echo(f"  Week {week}: no differences")
    else:
        click.echo("Projection weeks: none")

    if not changes_found:
        click.echo("No differences versus baseline data.")

__all__ = ["cli"]
