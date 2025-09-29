# Fantasy Data Pipeline & Scenario Contract

This document describes the data artifacts that power the fantasy dashboard, how the refresh + simulation pipeline populates them, and how scenario overlays layer on top of ESPN exports without mutating your source data.

---

## 1. Baseline Artifacts

Artifacts live under `data/` at the repository root. Files inside `data/raw` and `data/in` are intermediate and gitignored; the UI consumes the normalized outputs inside `data/out` plus any overlays committed in `data/overlays`.

| Path | Produced by | Purpose |
|------|-------------|---------|
| `data/out/espn/<season>/teams.csv` | `fantasy espn normalize` | Canonical team metadata (names, owners, logos, divisions). |
| `data/out/espn/<season>/schedule.csv` | `fantasy espn normalize` | Schedule with home/away assignments and ESPN matchup IDs. |
| `data/out/espn/<season>/weekly_scores_<week>.csv` | `fantasy score week` | Finalized fantasy scores per roster slot for completed weeks. |
| `data/out/espn/<season>/weekly_stats_<week>.csv` | `fantasy score week` | Raw stat lines joined to nflverse IDs; feeds scoring breakdowns. |
| `data/out/projections/<season>/week_<week>.json` | `fantasy refresh-all` | Projection snapshots used by rest-of-season sims. |
| `data/out/simulations/<season>/rest_of_season.json` | `fantasy sim rest-of-season` | Baseline simulation payload consumed by the frontend. |
| `data/out/simulations/<season>/rest_of_season__scenario-<slug>.json` | `fantasy sim rest-of-season --scenario` | Scenario-specific simulator output (same schema as baseline). |
| `data/overlays/<season>/*.json` | scenario CLI | Overlay definitions (committed). |

> **Tip:** Set `FANTASY_REPO_ROOT` when running the frontend outside the repo so it can locate `data/out` and `data/overlays`.

---

## 2. Refresh Pipeline

`poetry run fantasy refresh-all` orchestrates the baseline pipeline. Each stage writes deterministic files so reruns can be diffed.

1. **ESPN pull** – Authenticated requests capture the private league views (`view-mSettings`, `view-mRoster`, etc.) into `data/raw/`.
2. **Normalization** – Views are transformed into tidy CSVs under `data/out/espn/<season>/` (teams, schedule, roster, scoring settings).
3. **Scoring** – `fantasy score` applies the custom scoring table (`config/scoring.yaml`) to completed weeks, filling the `weekly_scores_*` CSVs.
4. **Projection sync** – nflverse + FantasyCalc projections hydrate `data/out/projections/<season>/week_<n>.json` for upcoming weeks.

Once the baseline data is refreshed, run `fantasy sim rest-of-season` to aggregate the completed weeks, projections, and Monte Carlo odds into the frontend-ready JSON.

### Simulator Output (baseline + scenarios)

Every simulator JSON shares the same top-level contract:

```jsonc
{
  "season": 2025,
  "generated_at": "2025-09-28T19:10:30.591918+00:00",
  "start_week": 5,
  "end_week": 13,
  "projection_sigma": 18.0,
  "teams": [ /* metadata */ ],
  "schedule": { /* weekly projections and finals */ },
  "standings": { /* deterministic table */ },
  "monte_carlo": { /* playoff odds */ },
  "sources": {
    "completed_weeks": [1, 2, 3, 4],
    "projections_weeks": [5, 6, 7, 8, 9, 10, 11, 12, 13],
    "scenario_id": "baseline"
  },
  "scenario": {
    "id": "baseline",
    "label": "Baseline",
    "is_baseline": true,
    "overrides": {
      "completed_weeks": [],
      "projection_weeks": []
    },
    "description": "Official ESPN dataset (no overlays)"
  }
}
```

Scenario runs populate the same structure, with `scenario.id` matching the overlay ID and `sources.scenario_id` reflecting the overlay slug.

---

## 3. Scenario Overlays

Overlays let you explore counterfactuals (different historical outcomes, roster edits, projection tweaks) without altering ESPN source files. They are stored in `data/overlays/<season>/` and merged at sim time.

- **Baseline integrity** – The overlay engine never mutates `data/out/espn`. Clearing `data/overlays` reverts the simulator to raw ESPN data.
- **Granularity** – Overrides can target full matchup scores, team totals, or individual players (historical scores or future projections).
- **Stacking rules** – Player-level overrides roll up into team totals. Team `set-score` commands take precedence if both are applied.
- **Simulation prerequisite** – Editing an overlay does not auto-run the sim. Invoke `fantasy sim rest-of-season --scenario <id>` so the frontend sees the new JSON.

### Overlay JSON Shape

```jsonc
{
  "scenario_id": "demo-upset",
  "label": "Buzzsaw Week 1 Upset",
  "description": "Flips week 1 vs Team 10 and boosts week 5 projection.",
  "season": 2025,
  "completed_weeks": {
    "1": {
      "teams": {
        "8": {
          "entries": [
            {
              "player_name": "Scenario Win",
              "lineup_slot": "QB",
              "espn_player_id": 15847,
              "score_total": 105.0,
              "score_base": 80.0,
              "score_bonus": 25.0,
              "counts_for_score": true
            }
          ]
        }
      },
      "matchups": {
        "3": {
          "home_team_id": 3,
          "away_team_id": 8,
          "home_points": 50.0,
          "away_points": 100.0,
          "winner": "AWAY",
          "notes": "Demo override"
        }
      }
    }
  },
  "projection_weeks": {
    "5": {
      "teams": {
        "1": {
          "entries": [
            {
              "player_name": "Future Override",
              "lineup_slot": "QB",
              "projected_points": 132.7,
              "counts_for_score": true
            }
          ]
        }
      }
    }
  },
  "updated_at": "2025-09-28T17:59:13.042105+00:00"
}
```

- `scenario_id` must match the filename slug (`demo-upset.json`).
- `completed_weeks` and `projection_weeks` are dictionaries keyed by week number (string). Missing keys fall back to the baseline dataset.
- `teams[].entries[]` mirrors the structure in `weekly_scores_*` / projection files. Field names include:
  - `player_name`, `lineup_slot`, `espn_position`, `espn_player_id`
  - Historical scoring: `score_total`, `score_base`, `score_bonus`, `score_position`, `counts_for_score`
  - Projection overrides: `projected_points`
  - `scenario_override` (bool) flags synthetic rows when no ESPN player is associated.
- `matchups` ensures team totals and winner alignment. If omitted, totals are recomputed from player entries.
- `updated_at` is refreshed automatically by the CLI.

---

## 4. Scenario CLI Workflows

The CLI lives under `poetry run fantasy scenario`. Commands validate inputs, update the overlay JSON, and maintain team/matchup totals.

| Command | Description |
|---------|-------------|
| `create` | Bootstrap a new overlay file with metadata (season, label, description). |
| `describe` | Summarize metadata, touched weeks, and counts of overrides. |
| `diff` | Compare overlay-adjusted results versus the baseline dataset. |
| `set-score` | Adjust a completed matchup outcome (home/away totals + winner). |
| `set-player-score` | Override individual player fantasy points for a completed week. |
| `set-projection` | Override a team-level projected total for a future week. |
| `set-player-projection` | Override an individual player's projected points. |

### Typical Flow

```bash
# 1. Create the overlay file
poetry run fantasy scenario create --season 2025 --id demo-upset --label "Buzzsaw Week 1 Upset"

# 2. Apply overrides
poetry run fantasy scenario set-player-score --season 2025 --id demo-upset --week 1 \
  --team 8 --player-name "Patrick Mahomes" --lineup-slot QB --points 45.6
poetry run fantasy scenario set-score --season 2025 --id demo-upset --week 1 \
  --home-team 3 --away-team 8 --home 98.4 --away 126.1

# 3. Inspect the delta
poetry run fantasy scenario diff --season 2025 --id demo-upset

# 4. Regenerate simulator output
poetry run fantasy sim rest-of-season --season 2025 --scenario demo-upset

The simulator infers `start_week` and `end_week` from the baseline artifacts, keeping the command future-proof as the season advances.
```

> **Reminder:** Only baseline simulations run automatically when the UI refresh button is pressed. Rerun the simulator manually for each scenario you edit.

---

## 5. Operational Runbook

### Baseline refresh (daily cadence)
1. `poetry run fantasy refresh-all --season 2025`
2. `poetry run fantasy sim rest-of-season --season 2025 --simulations 500`

Both commands auto-detect the current matchup period and projection horizon, so no week parameters are required during the regular cadence. Add `--start-week` / `--end-week` only for historical backfills or what-if reruns.
3. `npm run build && pm2 restart fantasy-web` (when serving the production build)

> **Automation:** `npm run refresh-scheduler` mirrors the UI button by calling the `/api/sim/rest-of-season/trigger` route. Default cadence is 1 minute during published NFL windows (Thu night, Sun slots, Mon night) and 15 minutes otherwise; customise via `config/refresh-overrides.json` or `FANTASY_REFRESH_*` env vars before wiring the process into PM2. Each successful pass snapshots artifacts to `data/history/` and appends a JSON diff row to `data/history/refresh-diff.log` so operators can answer “what changed between runs?” immediately (use `npm run refresh-last-diff` for a quick summary). Retention is capped by `FANTASY_REFRESH_MAX_SIM_HISTORY`, `FANTASY_REFRESH_MAX_SCORE_HISTORY`, and `FANTASY_REFRESH_MAX_DIFF_LOG_LINES` so history doesn’t balloon.

### Scenario maintenance
1. Edit overlays via CLI (`set-player-score`, `set-player-projection`, etc.).
2. `poetry run fantasy sim rest-of-season --season 2025 --scenario <id>` for each updated overlay.
3. Confirm the UI toggles between baseline and scenario datasets without hydration warnings.

### Troubleshooting
- **Refresh button shows “Last refresh failed”** – Inspect `apps/web/src/server/sim-job.ts` logs (PM2) for CLI output; rerun the failing command manually.
- **Hydration mismatch** – Ensure baseline and scenario JSONs include the expected `generated_at`. Regenerate if one is stale.
- **Missing scenario in UI** – Check `data/overlays/<season>/<id>.json` validity (`poetry run fantasy scenario describe ...`); invalid JSON is skipped.

---

## 6. Frontend Contract

- Scenario metadata comes from `listScenarios` (`apps/web/src/lib/scenario-data.ts`). Any JSON in `data/overlays/<season>/` with a valid `scenario_id` becomes an option.
- `/api/sim/rest-of-season` reads from `data/out/simulations/<season>/rest_of_season*.json`. Baseline requests fall back to the non-suffixed file; scenario requests look for `rest_of_season__scenario-<slug>.json`.
- `/api/sim/rest-of-season/status` returns the job log plus the most recent `generated_at`. The frontend compares this to the currently loaded dataset to determine the status banner.
- The grid renders deterministic values from the simulator JSON: `completed_weeks` results mark games as “Final”, while future weeks display projections and Monte Carlo odds.

Keep the simulator schema backward-compatible; adding fields is safe, but renaming/removing should be accompanied by Next.js updates.

---

## 7. Future Enhancements

- Document CLI helpers for `scenario clone` / `scenario delete` once implemented.
- Add integration tests around overlay conflict handling (`tests/test_cli_scenario.py`).
- Extend the UI to surface overlay descriptions and per-player diffs directly in the matchup matrix.

---

Last updated: 2025-09-29 (aligned with scenario overlay rollout).
