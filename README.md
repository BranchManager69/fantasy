<p align="center">
  <img src="docs/assets/fantasy-wordmark.svg" alt="Fantasy League Engine wordmark" width="480">
</p>

<p align="center">
  <a href="#environment-setup">Environment Setup</a>
  · <a href="#refresh--simulation-runbook">Refresh & Simulation Runbook</a>
  · <a href="#scenario-overlays">Scenario Overlays</a>
  · <a href="#frontend-usage">Frontend Usage</a>
  · <a href="#testing--quality">Testing</a>
  · <a href="#license">License</a>
</p>

<h1 align="center">Fantasy League Engine</h1>

<p align="center">
  <a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/python-3.11%2B-3776AB.svg" alt="Python 3.11+"></a>
  <a href="https://nodejs.org/en/download"><img src="https://img.shields.io/badge/node-18%2B-3C873A.svg" alt="Node 18+ (Next.js frontend)"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2F855A.svg" alt="MIT License"></a>
  <a href="docs/frontend-ux-data-contract.md"><img src="https://img.shields.io/badge/docs-Data%20Pipeline%20%2B%20Scenarios-1D4ED8.svg" alt="Data Pipeline & Scenarios"></a>
</p>

<p align="center">
  A comprehensive fantasy football analytics platform that combines ESPN league data with advanced Monte Carlo simulations to provide live standings, playoff odds, and scenario analysis through an intuitive web dashboard.
</p>

---

## Highlights

- **Live Monte Carlo simulations** – Real-time playoff odds and rest-of-season projections powered by thousands of Monte Carlo runs using actual ESPN league data.
- **Scenario exploration** – Commissioners can create "what-if" overlays to explore alternative outcomes without affecting the baseline data or league settings.
- **Automated data pipeline** – Seamless integration with ESPN APIs and nflverse for accurate, up-to-date player projections and completed game results.
- **Professional dashboard** – Modern Next.js interface with team-by-team breakdowns, live game tracking, and detailed analytics for every matchup.

---

## Project Structure

```
.
├── apps/web/                 # Next.js App Router frontend
├── config/                   # Scoring configuration and env templates
├── data/
│   ├── overlays/<season>/    # Scenario overlay JSON (checked in)
│   ├── raw/                  # Source dumps (gitignored)
│   ├── in/                   # Intermediate artifacts (gitignored)
│   └── out/                  # Generated outputs consumed by the UI
├── docs/                     # Data pipeline + UX notes
├── src/fantasy_nfl/          # Python package
├── tests/                    # CLI + simulator tests
└── README.md
```

---

## Environment Setup

1. Install Poetry once:
   ```bash
   curl -sSL https://install.python-poetry.org | python3 -
   ```
2. Install backend dependencies:
   ```bash
   poetry install
   ```
3. Copy and configure the environment file (ESPN league + auth details):
   ```bash
  cp config/env.example .env
   # fill in league_id, espn_s2, swid, etc.
   ```
4. (Optional) install frontend deps for development:
   ```bash
   npm install
   ```

---

## Refresh & Simulation Runbook

All commands default to the season defined in `.env` unless overridden.

- **Full refresh pipeline** (ESPN pulls → normalization → scoring → projections):
  ```bash
  poetry run fantasy refresh-all --season 2025
  ```
  The command auto-detects the active matchup period, fetches live scoreboard data, and expands projections through the furthest available week. Outputs land in `data/out/espn/2025/` and `data/out/projections/2025/` (gitignored).

- **Rest-of-season simulator (baseline)**:
  ```bash
  poetry run fantasy sim rest-of-season --season 2025 --simulations 500
  ```
  Week windows default to “next unplayed” through the latest projection file, so the resulting `data/out/simulations/2025/rest_of_season.json` remains future-proof. Override `--start-week/--end-week` only when running historical backfills.

- **Rest-of-season simulator (with overlay)**:
  ```bash
  poetry run fantasy sim rest-of-season --season 2025 --scenario demo-upset
  ```
  Output lands at `data/out/simulations/2025/rest_of_season__scenario-demo-upset.json`. Trigger a manual run whenever an overlay changes.

- **Frontend rebuild + PM2 restart** (if serving production build):
  ```bash
  npm run build
  pm2 restart fantasy-web
  ```

The Next.js refresh button calls the `/api/sim/rest-of-season/trigger` route. Behind the scenes it runs `poetry run fantasy refresh-all` (auto week detection) followed by the baseline `poetry run fantasy sim rest-of-season`. Scenario datasets remain a deliberate, manual run so refresh durations stay predictable.

### Automatic refresh scheduler

- **Game-time updates** – Automatically refreshes during NFL broadcast windows (Thu/Sun/Mon evenings) every minute (`FANTASY_REFRESH_GAME_INTERVAL_MINUTES`), with 60-minute intervals off-hours (`FANTASY_REFRESH_IDLE_INTERVAL_MINUTES`)
- **Custom schedules** – Add `config/refresh-overrides.json` for holiday games or special events
- **Background service** – Run `npm run refresh-scheduler` to enable automatic updates
- **Change tracking** – Uses a diff log to summarize stat swings; see `npm run refresh-last-diff`
- **Retention tuning** – To preserve longer replays, set:
  - `FANTASY_REFRESH_MAX_SCORE_HISTORY=360` (≈6 hours of per-minute snapshots)
  - `FANTASY_REFRESH_MAX_SIM_HISTORY=240`
  - `FANTASY_REFRESH_MAX_DIFF_LOG_LINES=50000` (or 0 to keep all)

---

## Scenario Overlays

Scenario overlays live under `data/overlays/<season>/` and are never generated by the baseline refresh. They describe adjustments to completed weeks and/or upcoming projections without editing ESPN exports.

### Key Commands

```bash
# Create a fresh overlay (pre-populates metadata)
poetry run fantasy scenario create --season 2025 --id alt-week4 --label "Alternate Week 4"

# Override a completed-week score (team totals + matchup winner stay in sync)
poetry run fantasy scenario set-score --season 2025 --id alt-week4 --week 1 --home-team 1 --away-team 10 --home 88.4 --away 74.1

# Adjust an individual player's historical score
poetry run fantasy scenario set-player-score --season 2025 --id alt-week4 --week 1 \
  --team 1 --player-name "Josh Allen" --lineup-slot QB --points 32.5

# Update future projections at the player level
poetry run fantasy scenario set-player-projection --season 2025 --id alt-week4 --week 5 \
  --team 1 --player-name "Bijan Robinson" --lineup-slot RB --points 21.3

# Inspect differences from the baseline dataset
poetry run fantasy scenario diff --season 2025 --id alt-week4
```

After editing an overlay, re-run the simulator with `--scenario <id>` to regenerate the JSON consumed by the UI. Use `poetry run fantasy scenario describe --season 2025 --id alt-week4` to confirm metadata (updated `label`, last edited timestamp, weeks touched).

### Overlay File Layout

```jsonc
{
  "scenario_id": "demo-upset",
  "label": "Buzzsaw Week 1 Upset",
  "description": "Flips week 1 vs Team 10 and boosts week 5 projection.",
  "completed_weeks": {
    "1": {
      "teams": {
        "3": { "entries": [ /* roster + score overrides */ ] }
      },
      "matchups": {
        "3": { "home_team_id": 3, "away_team_id": 8, "winner": "AWAY" }
      }
    }
  },
  "projection_weeks": {
    "5": {
      "teams": {
        "1": { "entries": [ /* projected_points overrides */ ] }
      }
    }
  },
  "updated_at": "2025-09-28T17:59:13.042105+00:00"
}
```

- `teams[].entries[]` contains player overrides for scores or projections
- `matchups` defines game results and winners to keep standings consistent

---

## Frontend Usage

- **Scenario switching** – Choose from available overlays in `data/overlays/<season>/`
- **API endpoints**:
  - `GET /api/sim/rest-of-season?scenario=<id>` – Get simulation results
  - `POST /api/sim/rest-of-season/trigger` – Trigger new simulation run
  - `GET /api/sim/rest-of-season/status` – Check simulation status

---

## Documentation

- **Data Pipeline & Scenarios** – `docs/frontend-ux-data-contract.md`
- **Scoring configuration** – `config/scoring.yaml`
- **Overlay samples** – `data/overlays/2025/*.json`

---

## Testing & Quality

```bash
# Run backend tests
poetry run pytest

# Run frontend linting
npm run lint
```

---

## License

Distributed under the [MIT License](LICENSE).
