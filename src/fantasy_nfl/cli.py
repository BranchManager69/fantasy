from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Optional

import click

from .auth import EspnAuthenticator
from .espn import EspnClient, ensure_views
from .merge import DataAssembler
from .normalize import EspnSnapshot, normalize_roster, normalize_schedule, normalize_teams, write_dataframe
from .scoring import ScoreEngine, ScoringConfig
from .nflverse import NflverseDownloader
from .settings import AppSettings, get_settings


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


@cli.group()
def audit() -> None:
    """Validation helpers."""


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

__all__ = ["cli"]
