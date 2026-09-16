# Fantasy League Engine

An ESPN fantasy league website with weekly results, historical lineups, bench replays, and season simulations. The 2026 home page connects league outcomes to specific NFL plays. The previous season dashboard is available at `/season`.

## 2026 revival

Week 1 uses ESPN's historical scoring-period roster, so later roster changes cannot rewrite the starting lineup. Each starter total is checked against the official team score. The matchup explorer compares a team's score against every opponent and permits one position-eligible bench substitution using final points.

The featured Monday lead change is reconstructed from nflverse play-by-play and league scoring rules. Its before/after totals use corrected data, rather than an archived live scoreboard. The evidence builder verifies the relevant player totals against ESPN and refuses inconsistent inputs. AI conversation is still pending; the current stories are computed and written from verified evidence.

The season simulation preserves completed results and projects the remaining regular season. Future weeks currently carry forward the selected starters, including bye-week zeros. Treat playoff odds as a projection under that assumption.

## Setup

Requires Python 3.11+ and Node 22. Copy `.env.example` to `.env`, then set the ESPN league ID, season, and authentication cookies. Keep credentials and generated league data out of Git.

```bash
poetry config virtualenvs.in-project true --local
poetry install
npm ci --prefix apps/web
```

The Python commands below run from the repository root. The web server reads `DATA_ROOT`, or the repository's `data/` directory. Set `FANTASY_REPO_ROOT` when running from a separate release directory; `FANTASY_PYTHON` can override the `.venv/bin/python` interpreter used by the refresh button.

## Refresh the league

```bash
poetry run fantasy refresh-week --season 2026 --week 1 --config config/scoring-2026.yaml
poetry run fantasy refresh-all --season 2026 --config config/scoring-2026.yaml
poetry run fantasy sim rest-of-season --season 2026 --simulations 500
poetry run python scripts/refresh-league-week.py --season 2026 --week 1
```

The scoring config is league-specific. The 2026 file matches this league's ESPN rules, including whole 25-yard passing units, long-touchdown bonuses, and passing two-point conversions. Another league must supply its own rules.

`refresh-all` detects the active week and regular-season horizon from ESPN. The website's season refresh control runs it before the simulation. The weekly report is refreshed separately with `refresh-league-week.py`; `--cached` rebuilds from an existing historical snapshot.

For the supported Week 1 story, cache nflverse's 2026 play-by-play file at `data/raw/nflverse/play_by_play_2026.csv`, then run:

```bash
poetry run python scripts/build-week-moments.py --season 2026 --week 1 --config config/scoring-2026.yaml
```

The moments builder currently supports the verified 2026 Week 1 matchup. It is an initial example of evidence extraction; later weeks need additional play selection and narrative work.

## Serve the website

```bash
npm run build --prefix apps/web
cd apps/web
pm2 start npm --name fantasy-web -- run start --hostname 127.0.0.1 --port 40435
```

The isolated 2026 preview can instead be started from the repository root with `pm2 start ecosystem.revival.config.js`. It binds the existing site upstream port 40435; run only one web process on that port.

Production uses the built Next.js application under PM2. Rebuild and restart the web process after source changes. The optional scheduler (`npm run refresh-scheduler`) is a separate process and should be enabled only after checking its configured host and refresh interval.

## Data and scenarios

- `data/raw/`: cached ESPN and nflverse responses.
- `data/out/league/<season>/`: weekly website reports and play evidence.
- `data/out/espn/<season>/`: normalized teams, schedule, and scoring artifacts.
- `data/out/projections/<season>/`: player projections and provider coverage.
- `data/out/simulations/<season>/`: baseline and scenario simulation results.
- `data/overlays/<season>/`: scenario changes kept separately from baseline data.

The `fantasy scenario` commands create overlays and change historical scores or future projections. Run `fantasy scenario --help` for available operations, then `fantasy sim rest-of-season --scenario <id>` to generate a scenario dataset. See [the existing data contract](docs/frontend-ux-data-contract.md) for the earlier dashboard and overlay format.

## Verification

```bash
poetry run pytest
npm run build --prefix apps/web
npm audit --prefix apps/web
```

Tests cover score mapping, import compatibility, completed-week detection, the simulation horizon, historical lineups, and the featured play reconstruction. Browser checks should include team selection, bench eligibility, a score-changing substitution, and mobile layout.

Released under the [MIT License](LICENSE).
