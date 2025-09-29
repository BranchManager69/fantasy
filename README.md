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
  ESPN + nflverse ingester, scoring engine, and Next.js dashboard that power live standings, Monte Carlo playoff odds, and scenario overlays without touching the baseline data pull.
</p>

---

## Highlights

- **Historical accuracy** – completed weeks are sourced directly from ESPN scoreboards and locked into the simulator before Monte Carlo runs begin.
- **Overlay system** – scenario JSON files layer on top of the baseline artifacts so commissioners can explore what-if edits without mutating source pulls.
- **End-to-end refresh** – `poetry run fantasy refresh-all` hydrates raw views, scoring, and projections for a season; the frontend pulls the latest artifacts directly from `data/out/`.
- **Next.js control plane** – the `/` and `/teams/[id]` screens surface the simulator grid with scenario switching, manual refresh triggers, and status readouts.

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
   cp .env.example .env
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

- **Runtime profile** – the full `refresh-all` + baseline sim combo currently completes in ~11 seconds on the branch manager host (latest run: 10.9s wall clock, 161 MB peak RSS). This leaves ample headroom for a 1-minute cadence during live games.
- **Scheduler entry point** – `npm run refresh-scheduler` executes `scripts/refresh-scheduler.js`, which pings the same API endpoint as the UI button and respects the in-process job lock. The default windows are keyed to NFL broadcast times in Eastern Time:
  - Thursday 7:00 PM–12:30 AM, Sunday 9:30 AM–12:30 PM / 12:00 PM–8:30 PM / 8:00 PM–12:30 AM, Monday 7:00 PM–12:30 AM (plus the late-night spillovers).
  - During those windows, the scheduler fires every **1 minute**; outside of them it falls back to a **15-minute** cadence.
- **Overrides** – drop a `config/refresh-overrides.json` (example: `config/refresh-overrides.sample.json`) to add or tweak windows for holiday games. Each entry accepts `{ "start": "HH:MM", "end": "HH:MM", "intervalMinutes": 1, "label": "thanksgiving" }`.
- **PM2 integration** – run it alongside the web app:
  ```bash
  pm2 start npm --name fantasy --cwd /home/branchmanager/tools/fantasy -- run refresh-scheduler
  ```
  Environment knobs include `FANTASY_REFRESH_API_BASE` (default `http://127.0.0.1:40435`), `FANTASY_REFRESH_GAME_INTERVAL_MINUTES`, and `FANTASY_REFRESH_IDLE_INTERVAL_MINUTES`.
- **Diff history** – each successful run snapshots artifacts under `data/history/` and appends a JSON line to `data/history/refresh-diff.log`, capturing team totals and top player swings between runs.

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

- `teams[].entries[]` mirrors the scoring artifact schema (`player_name`, `lineup_slot`, `score_total`, `projected_points`, etc.).
- `matchups` enforces team totals + winner so downstream standings remain consistent.
- `projection_weeks` can appear as `projection_weeks` or `projections`; both map to the same structure for backward compatibility.

---

## Frontend Usage

- The server resolves data directories relative to repo root (`apps/web/src/lib/paths.ts`). Override with `FANTASY_REPO_ROOT` when running outside the mono-repo.
- Scenario picker options come from `data/overlays/<season>/*.json`. Baseline is always available even if no overlays exist.
- API routes:
  - `GET /api/sim/rest-of-season?scenario=<id>` returns the latest simulator JSON for the requested scenario (404 if the overlay has not been simulated yet).
  - `POST /api/sim/rest-of-season/trigger?scenario=<id>` kicks off the build; the UI uses baseline-only to keep runtime reasonable.
  - `GET /api/sim/rest-of-season/status?scenario=<id>` reports job state plus the last completed dataset timestamp.
- The hydration timestamp displayed in `RefreshControls` is sourced from `dataset.metadata.generated_at`; mismatches indicate the baseline/scenario JSONs were generated at different times.

---

## Documentation

- **Data Pipeline & Scenarios** – `docs/frontend-ux-data-contract.md`
- **Scoring configuration** – `config/scoring.yaml`
- **Overlay samples** – `data/overlays/2025/*.json`

---

## Testing & Quality

- Run backend tests:
  ```bash
  poetry run pytest
  ```
- Add targeted tests in `tests/test_cli_scenario.py` when expanding the scenario CLI.
- Frontend smoke tests run via `npm run lint` / `npm run test` (configure as needed for Next.js workspace).

---

## License

Distributed under the [MIT License](LICENSE).
