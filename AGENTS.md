### High-level architecture
- Backend (Python, `src/fantasy_nfl`):
  - CLI groups: `auth`, `espn`, `nflverse`, `score`, `projections`, `calc`, `sim`, `scenario`, plus orchestration commands `refresh-week` and `refresh-all`.
  - Data flow:
    - ESPN ingest via `EspnClient` to `data/raw/espn/<season>/view-*.json`.
    - Normalize to CSVs in `data/out/espn/<season>/` (teams, schedule, weekly stats/scores).
    - Scoring via `ScoreEngine` using `config/scoring.yaml`.
    - Projections via `ProjectionBaselineBuilder` (usage lookback) and `EspnProjectionProvider`; combined by `build_projection_baseline`, then scored by `ProjectionManager` into `data/out/projections/<season>/projected_stats_week_<n>.csv`.
    - Simulator `RestOfSeasonSimulator` merges completed weeks + future projections, builds dataset JSON and optional Monte Carlo summary under `data/out/simulations/<season>/rest_of_season*.json`. Applies overlay overrides via `OverlayStore` and `ScenarioOverlay`.
  - Overlays: JSON files in `data/overlays/<season>/*.json` modify completed-week results and/or projections. CLI under `fantasy scenario` manages creation, edits, diff, describe.
  - NFL data: `NflverseDownloader` pulls and validates nflverse CSVs.
  - FantasyCalc: lightweight fetchers for trade charts and redraft values.

- Frontend (Next.js, `apps/web`):
  - Reads real artifacts from `data/out` and overlays from `data/overlays`; repo root resolved via `FANTASY_REPO_ROOT` or directory walk.
  - API routes:
    - `GET /api/sim/rest-of-season`: returns latest or season-specific simulation JSON (with optional `?scenario`).
    - `POST /api/sim/rest-of-season/trigger`: kicks off backend refresh + sim via `simJobRunner` (spawns `npm run refresh-all && poetry run fantasy sim rest-of-season --simulations 500 [--scenario ...]`).
    - `GET /api/sim/rest-of-season/status`: returns job snapshot and latest dataset `generated_at`.
    - `GET /api/scenario` and `GET /api/scenario/detail`: list scenarios and provide overlay + diff summary.
    - `GET /api/matchup/detail`: scenario-aware matchup view resolving projected/actual player lines; pulls overlay team entries if present.
  - UI: matrix table of teams vs weeks, scenario switching, refresh controls, live activity feed, team timelines, odds coloring, highlight cards. Types in `src/types`, helpers in `src/lib`.

- Operations
  - `README.md` documents setup and runbook. Scheduler scripts:
    - `scripts/refresh-scheduler.js` periodically calls the trigger/status endpoints with game-window cadence, archives snapshots to `data/history`, and produces a diff log summarizing team/player deltas per refresh.
    - `scripts/show-latest-diff.js` prints the last diff summary.

### Key artifacts and contracts
- Backend outputs under `data/out/espn/<season>/` and `data/out/projections/<season>/`.
- Simulator JSON schema consumed by UI is defined in `apps/web/src/lib/simulator-data.ts`. Overlay diff endpoints use `scenario-service.ts`.


### Production workflow & constraints

- Build, then restart with PM2. Do not skip the restart.
  - Frontend: `npm run build` then `pm2 restart fantasy-web`
  - Backend: `pm2 restart fantasy`
- No dev servers in production. Never start `npm run dev`, watch modes, or any non–PM2 process on prod hosts.
- Production domain: https://fantasy.branch.bet
- Refresh pipeline in production (non-interactive):
  - Trigger: `POST /api/sim/rest-of-season/trigger`
  - Monitor: `GET /api/sim/rest-of-season/status`
  - Read dataset: `GET /api/sim/rest-of-season?scenario=<id|baseline>`
