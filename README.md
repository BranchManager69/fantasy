# Fantasy League Engine

An ESPN fantasy league website with weekly results, historical lineups, bench replays, and season simulations. The 2026 home page connects league outcomes to specific NFL plays. The previous season dashboard is available at `/season`.

## 2026 revival

Week 1 uses ESPN's historical scoring-period roster, so later roster changes cannot rewrite the starting lineup. Each starter total is checked against the official team score. The matchup explorer compares a team's score against every opponent and permits one position-eligible bench substitution using final points.

The featured Monday lead change is reconstructed from nflverse play-by-play and league scoring rules. Its before/after totals use corrected data, rather than an archived live scoreboard. The evidence builder verifies the relevant player totals against ESPN and refuses inconsistent inputs. The AI analyst uses OpenAI's Agents API with GPT-6 Astra. It can read the selected matchup, inspect eligible bench swaps, and retrieve sourced NFL plays. The home-page story remains a reproducible evidence report.

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

The isolated 2026 preview builds separately with `FANTASY_NEXT_DIST_DIR=.next-analyst npm run build --prefix apps/web`, then starts from the repository root with `pm2 start ecosystem.revival.config.js`. It binds the existing site upstream port 40435; run only one web process on that port.

Production uses the built Next.js application under PM2. Rebuild and restart the web process after source changes. The optional scheduler (`npm run refresh-scheduler`) is a separate process and should be enabled only after checking its configured host and refresh interval.

## AI analyst

Supply `OPENAI_API_KEY` in the web process environment. It stays on the server and is never sent to the hosted workspace or browser. The key needs Agents API access and inference permission. The question form makes a model request only when submitted.

Each question receives verified matchup, complete legal-lineup optimization and game evidence before its OpenAI-hosted session starts. Application functions remain available for further research. The writer can also search the web for relevant NFL reporting and source links. Sandbox network access and subagents remain disabled. `FANTASY_ANALYST_MODEL` selects the writer independently of the evidence pipeline; its editorial instructions live in `analyst-writer.ts`.

The browser receives actual progress events and shows elapsed time. Completed answers survive optional usage-accounting failures. A browser disconnect or 180-second deadline sends server cancellation before cleanup; hosted resource cleanup continues asynchronously after deletion is accepted. Receipts distinguish timeouts from disconnects and retain the last stage and completed tool names.

The preview allows six attempts per UTC day across the league and one active request at a time. `FANTASY_ANALYST_DAILY_LIMIT` may lower this or raise it to at most 20. Failed attempts count. Receipts in `data/history/analyst/runs/` record session/turn IDs, status, tool names and reported token usage; they omit keys, prompts and generated answers. Missing usage stays unknown. These are request limits, not a guaranteed dollar ceiling. The Agents API currently exposes no per-turn token ceiling.

If session creation or cleanup has an uncertain outcome, the durable reservation stays active and further questions pause. Inspect the corresponding run receipt, reconcile its OpenAI session, and confirm deletion before releasing it through `AnalystBudget.finish`. A restart never clears this reservation automatically.

```bash
npm run test:analyst --prefix apps/web
# One paid test using the same limits and evidence tools:
cd apps/web
npx tsx scripts/smoke-analyst.ts
```

The explicit smoke script additionally saves its answer beside its receipt for review. The web endpoint is `POST /api/analyst` with `season`, `week`, `teamId`, and `question`; clients requesting `Accept: text/event-stream` receive progress, result or error events with ten-second keepalives. Other clients receive JSON. `GET /api/analyst` reports availability without inference. Each submitted question is independent and uses the selected team and week.

API references: [quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart), [function tools](https://developers.openai.com/api/docs/guides/agents-api/tools/functions), [hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted).

## Private league studio

The private `/studio` workspace stores GM profiles, reference photos and sourced league memories. It combines these with weekly evidence to draft scenes, lets an editor revise them, and renders images on request. Producer plans and import progress are saved so interrupted work can resume.

See [the studio operations guide](docs/league-studio.md) for owner seeding, the confirmed Dillon account mapping, private access links, import formats, model settings and separate text/image limits. The store requires Linux `/usr/bin/flock`. Studio data stays under `DATA_ROOT/private/studio/` and is excluded from the public weekly feed.

The home page opens on official matchup scores. Select a team to revisit a verified turning point or compare its best legal lineup using final points. Turning points appear only where the saved evidence includes checked before/after scores. Other matchups retain their official result and supported lineup comparison. `FANTASY_DEFAULT_TEAM_ID` chooses the initial team; the `team` URL parameter overrides it.

After signing in to the studio, the same viewer can display saved episodes and assigned owner portraits. Its authenticated episode endpoint exposes only display names, scenes and image URLs. Backgrounds, chat sources, prompt text and memory records remain in the editor. Viewing an episode makes no AI request.

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
npm run test:studio --prefix apps/web
npm run test:replay --prefix apps/web
npm run build --prefix apps/web
npm audit --prefix apps/web
```

Tests cover score mapping, import compatibility, completed-week detection, the simulation horizon, historical lineups, and the featured play reconstruction. Browser checks should include team selection, bench eligibility, a score-changing substitution, and mobile layout.

Released under the [MIT License](LICENSE).
