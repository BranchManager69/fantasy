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

    teams_df = normalize_teams(team_view)
    roster_df = normalize_roster(roster_view)
    schedule_df = normalize_schedule(matchup_view)

    out_dir = settings.data_root / "out" / "espn" / str(settings.espn_season)
    teams_csv = write_dataframe(teams_df, out_dir / "teams.csv")
    roster_csv = write_dataframe(roster_df, out_dir / "roster.csv")
    schedule_csv = write_dataframe(schedule_df, out_dir / "schedule.csv")

    click.echo(f"Saved roster → {roster_csv}")
    click.echo(f"Saved teams → {teams_csv}")
    click.echo(f"Saved schedule → {schedule_csv}")


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

    teams_df = normalize_teams(team_view)
    roster_df = normalize_roster(roster_view)
    schedule_df = normalize_schedule(matchup_view)

    out_dir = settings.data_root / "out" / "espn" / str(target_season)
    teams_csv = write_dataframe(teams_df, out_dir / "teams.csv")
    roster_csv = write_dataframe(roster_df, out_dir / "roster.csv")
    schedule_csv = write_dataframe(schedule_df, out_dir / "schedule.csv")

    click.echo(f"Saved teams → {teams_csv}")
    click.echo(f"Saved roster → {roster_csv}")
    click.echo(f"Saved schedule → {schedule_csv}")

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
    )

    output_path = output or default_simulation_output(settings, target_season)
    path = simulator.write_dataset(dataset, output_path)
    mc = dataset.get("monte_carlo")
    sim_summary = ""
    if isinstance(mc, dict) and mc.get("iterations"):
        sim_summary = f", {mc['iterations']} sims"

    click.echo(
        f"Rest-of-season simulation → {path} (weeks {dataset['start_week']}-{dataset['end_week']}{sim_summary})"
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

    if effective_end is None:
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
__all__ = ["cli"]
