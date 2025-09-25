<p align="center">
  <img src="docs/assets/fantasy-wordmark.svg" alt="Fantasy League Engine wordmark" width="480">
</p>

<p align="center">
  <a href="#backend-quickstart">Backend Quickstart</a>
  · <a href="#architecture-overview">Architecture</a>
  · <a href="#data-artifacts">Data Artifacts</a>
  · <a href="#frontend-roadmap">Frontend Roadmap</a>
  · <a href="#testing--quality">Testing</a>
  · <a href="#license">License</a>
</p>

<h1 align="center">Fantasy League Engine</h1>

<p align="center">
  <a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/python-3.11%2B-3776AB.svg" alt="Python 3.11+"></a>
  <a href="https://nodejs.org/en/download"><img src="https://img.shields.io/badge/node-18%2B-3C873A.svg" alt="Node 18+ (planned frontend)"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2F855A.svg" alt="MIT License"></a>
  <a href="docs/frontend-ux-data-contract.md"><img src="https://img.shields.io/badge/docs-UX%20+%20Data%20Contract-1D4ED8.svg" alt="UX & Data Contract"></a>
</p>

<p align="center">
  Data pipeline + forthcoming frontend that turns decade-long fantasy leagues into a live, shareable hype engine—always driven by real ESPN/nflverse feeds.
</p>

---

## Highlights

- **Deterministic backend** – Python CLI ingests ESPN private leagues, normalizes snapshots, enriches with nflverse stats, and writes reproducible CSV outputs.
- **Scoring engine ready** – custom scoring (PPR, bonuses, position modifiers) applied directly to weekly datasets for instant standings.
- **Asset-aware** – plan for unified player/club imagery and AI-generated highlights tied to actual events.
- **Future Next.js shell** – upcoming web experience will render only real artifacts produced by the CLI; no fabricated data paths.

---

## Architecture Overview

| Layer | Responsibilities | Status |
|-------|------------------|--------|
| Backend (Python CLI) | Authenticated ESPN pulls, nflverse sync, normalization, scoring, artifact export | ✅ Active
| Data Artifacts | CSV/JSON outputs under `data/out/` feeding downstream consumers | ✅ Active
| Frontend (Next.js) | League narrative dashboard, matchup heat, community surfaces powered by real artifacts | 🛠️ In planning
| Docs | UX architecture & data contracts, future contribution guides | ✅ `docs/`

---

## Project Structure

```
.
├── apps/
│   └── web/               # Next.js App Router frontend (initial scaffold)
├── config/                # Scoring configs and env templates
├── data/raw/              # Cached source pulls (gitignored)
├── data/out/              # Generated outputs (gitignored)
├── docs/                  # UX notes, data contracts, assets
├── src/fantasy_nfl/       # Python package source
├── tests/                 # Test scaffolding
└── README.md
```

---

## Backend Quickstart

1. **Prerequisites**
   ```bash
   curl -sSL https://install.python-poetry.org | python3 -    # install Poetry once
   ```
2. **Install dependencies**
   ```bash
   poetry install
   ```
3. **Configure environment**
   ```bash
   cp .env.example .env
   # add ESPN credentials or cookies
   ```
4. **Inspect configuration**
   ```bash
   poetry run fantasy env
   ```
5. **Capture ESPN cookies**
   ```bash
   poetry run fantasy auth login          # or --browser / --show-browser if automation fails
   ```
6. **Pull & normalize league data**
   ```bash
   poetry run fantasy espn pull           # base views
   poetry run fantasy espn normalize      # writes teams/roster/schedule CSVs
   ```
7. **Sync nflverse stats**
   ```bash
   poetry run fantasy nflverse pull --season 2024
   ```
8. **Build weekly datasets + scoring**
   ```bash
   poetry run fantasy espn build-week --season 2024 --week 1
   poetry run fantasy score week --season 2024 --week 1
   ```
   Outputs land under `data/out/espn/<season>/` (e.g., `roster_enriched.csv`, `weekly_scores_*.csv`).
9. **Or run the all-in-one refresh**
   ```bash
   poetry run fantasy refresh-week --week 1
   ```
   Add `--force-nflverse` when you want fresh nflverse downloads, or `--skip-score` to stop before scoring.

---

## Data Artifacts

- `data/out/espn/<season>/teams.csv` – core team metadata (owners, logos, seeds).
- `data/out/espn/<season>/roster.csv` & `roster_enriched.csv` – active roster slots merged with nflverse IDs.
- `data/out/espn/<season>/schedule.csv` – matchup matrix with results and opponent mapping.
- `data/out/espn/<season>/weekly_stats_*.csv` – per-player stat lines joined to lineup slots.
- `data/out/espn/<season>/weekly_scores_*.csv` – scoring-engine output with base/bonus breakdowns.
- Planned extensions: highlights, insights, asset manifests (see `docs/frontend-ux-data-contract.md`).
- Next API route `GET /api/league` now exposes the latest season's `teams.csv` as JSON (returns 503 until artifacts exist).

---

## Frontend Roadmap

- Next.js App Router workspace lives at `apps/web/` (initial scaffold renders status cards, no mock data paths).
- Implement API routes that read the real CSV/JSON artifacts and emit the contracts defined in `docs/frontend-ux-data-contract.md`.
- Build the league home experience: narrative hero, live matchup strip, manager capsules, history rail.
- Layer in highlights/insights once backend produces those feeds; integrate asset manifest for player photos and team logos.

---

## Documentation & Guides

- **UX & Data Contract** → `docs/frontend-ux-data-contract.md`
- **Scoring configuration** → `config/scoring.yaml`
- Additional guides (frontend tooling, contribution flow) will land here as those components commit.

---

## Testing & Quality

- Run backend tests:
  ```bash
  poetry run pytest
  ```
- Linting/formatting hooks will be introduced as the codebase grows.
- Frontend testing strategy will be documented once the Next.js workspace is active.

---

## License

Distributed under the [MIT License](LICENSE).
