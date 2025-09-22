# Fantasy NFL Data Pipeline

Python-based toolkit to pull ESPN fantasy league data, merge with nflverse stats, compute league-specific fantasy points, and emit deterministic outputs.

## Project Structure
- `src/fantasy_nfl/`: package source code
- `config/`: scoring configs and environment templates
- `data/raw/`: cached source pulls (ignored in git)
- `data/out/`: computed outputs (ignored in git)
- `tests/`: automated tests and fixtures

## Quickstart
1. **Install Poetry** (once):
   ```bash
   curl -sSL https://install.python-poetry.org | python3 -
   ```
2. **Install dependencies**:
   ```bash
   poetry install
   ```
3. **Create your `.env`** (ignored by git) using `.env.example` as a baseline:
   ```bash
   cp .env.example .env
   # edit .env with throwaway ESPN email/password or cookie values
   ```
4. **Check config**:
   ```bash
   poetry run fantasy env
   ```
5. **Install the Playwright browser (once, for automated login)**:
   ```bash
   poetry run playwright install chromium
   ```
6. **Capture cookies**:
   - Attempt automated flow (HTTP first, optional browser automation):
     ```bash
     poetry run fantasy auth login
     ```
     Add `--browser` to force the Playwright path (and `--show-browser` to keep the window visible).
   - If ESPN prompts for CAPTCHA/MFA, launch an interactive window and sign in manually:
     ```bash
     poetry run fantasy auth manual
     ```
   Cookies are stored at `data/raw/auth/espn_cookies.json` once captured.
7. **Pull ESPN league data**:
   ```bash
   poetry run fantasy espn pull
   poetry run fantasy espn pull --view mSchedule --view mDraft
   ```
   Responses land under `data/raw/espn/<season>/view-*.json`.
8. **Normalize ESPN snapshots to tabular CSVs**:
   ```bash
   poetry run fantasy espn normalize
   ```
   Outputs are written to `data/out/espn/<season>/{teams,roster,schedule}.csv`.
9. **Download nflverse player + weekly stats**:
   ```bash
   poetry run fantasy nflverse pull --season 2024
   ```
   Files store under `data/raw/nflverse/players.csv` and `stats_player_week_<season>.csv`.
10. **Build merged roster/stats dataset for scoring**:
    ```bash
    poetry run fantasy espn build-week --season 2024 --week 1
    ```
    Creates `roster_enriched.csv` and `weekly_stats_<season>_week_<N>.csv` in `data/out/espn/<season>/`.

As modules land, this README will expand with detailed commands for pulling ESPN data, caching nflverse stats, scoring, and exporting results.

## Configuration
- Scoring rules live in `config/scoring.yaml`. Adjust weights, bonuses, and position modifiers to match your league; DST/K entries are omitted by default.
- Data/cache roots default to `./data`; override via environment variables if desired.

## Development
- Run tests with `poetry run pytest` (fixtures to be added once sample pulls are in place).
- Formatting/linting hooks will be added as the codebase grows.
