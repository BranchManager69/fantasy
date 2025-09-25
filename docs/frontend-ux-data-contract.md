# Fantasy Frontend: UX Architecture & Data Contract

## 1. Product North Star
- **Mission**: turn raw league data into a living, hype-fueled clubhouse for long-running fantasy leagues.
- **Primary users**: league managers who want weekly context, trash-talk fuel, historical receipts, and AI-driven storylines.
- **Guiding principles**: always contextual (what matters right now), always personal (tailored to each team), built for shared moments (easy sharing, dramatic visuals), resilient (progressively enhance; graceful with stale data).

## 2. Experience Architecture
### 2.1 Platform & Stack (to confirm)
- Proposed: web app on Next.js App Router + TypeScript; styling can lean on Tailwind or a design-token-driven system. Confirm this aligns with team preferences.
- Optional: component workbench (Storybook or Ladle) if we want to iterate on widgets in isolation—call out if that adds too much overhead.
- Data fetch layer could be React Query or SWR; whichever we pick should wrap typed fetchers that hit API routes reading the CLI outputs.
- Feature flag hook only if we truly need to hide experimental AI features; otherwise skip.

### 2.2 Navigation Spine (initial concept)
- `/` **League Home** – narrative hub for the current week.
- `/teams/[teamId]` **Team Locker Room** – season timeline, roster heat map, media feed.
- `/matchups/[season]/[week]` **Week View** – live matchups, win-prob graphs, highlight reels.
- `/history/[season]` **Season Archive** – champion story, records, stat leaderboards.
- `/control` **Commissioner Console** – scoring knobs, content moderation for AI blurbs.

If we stay on Next App Router, this can map to nested layouts such as:
- `app/layout.tsx`: global shell (theme, ticker, etc.).
- `app/(public)/layout.tsx`: optional marketing shell.
- `app/(league)/layout.tsx`: authenticated shell (side rail with managers, notifications).
Revise once we lock auth requirements.

### 2.3 Core Modules (League Home candidates)
- **Narrative Hero**: rotating headline (e.g., “Team X needs 18.4 from Bijan to stay alive”), win-prob sparkline, actionable CTA.
- **Live Matchup Strip**: horizontally scrollable cards, real-time score delta, context chips ("bench points left").
- **Hot Moments Feed**: AI-generated or rule-based blurbs + media when thresholds trigger (needs backend support).
- **Manager Capsules**: each team card shows record, streak, vibe meter, next opponent, quick trash-talk snippet.
- **History Rail**: timeline chips linking to unforgettable weeks; shows throwback stats when hovered.
- **Community Wall**: blended chat, polls, meme submissions; future integration with Slack/Discord bot if desired.

### 2.4 Cross-cutting UX Systems
- **Alerting & Live States**: toast + pinned alerts for breaking news (injury, last-minute lineup change). Use optimistic updates when AI content queued.
- **Personalization**: allow user preference toggles (favorite team, noise level), stored in local storage & user profile when auth scales.
- **Accessibility**: color-safe palette for team colors; provide text alternatives for media; ensure keyboard nav works across carousels.
- **Offline/Stale Data Handling**: show last refreshed timestamp, offer manual refresh, degrade to static copy when API offline.

## 3. Data Contract
The backend currently emits deterministic CSVs via the Python pipeline. Frontend will consume typed JSON served by Next API routes that wrap those files. Each route follows `GET /api/<domain>` returning versioned payloads. Fields called out explicitly as needing new upstream support are annotated in notes beneath each payload.

### 3.1 Transport Conventions
- All responses include `metadata` with `season`, `generated_at`, and `source` (e.g., `espn_view`, `nflverse_weekly`).
- Collections expose `items` arrays; singular resources expose `data`.
- Identifiers remain numeric where ESPN uses numbers; expose both raw IDs and friendly slugs for routing.

Example envelope:
```json
{
  "metadata": {
    "season": 2024,
    "generated_at": "2024-08-24T17:32:11Z",
    "source": "espn_normalize_v1"
  },
  "items": []
}
```

### 3.2 Core Domain Entities

#### League
Source: `view-mSettings.json`
```json
{
  "league_id": 123456,
  "season": 2024,
  "name": "The Long Game",
  "current_week": 11,
  "total_teams": 12,
  "playoff_week": 15,
  "scoring_rules_version": "config/scoring.yaml@1",
  "logo_url": "https://...",
  "history_available": [2015, 2016, 2023]
}
```
Notes: Most fields are present in the ESPN view today; confirm availability of `logo_url`.

#### Team
Source: `teams.csv`
```json
{
  "team_id": 3,
  "slug": "team-3-the-beasts",
  "name": "The Beasts",
  "abbrev": "BST",
  "owners": ["Chris G"],
  "division_id": 2,
  "logo_url": "https://...",
  "record": { "wins": 7, "losses": 3, "ties": 0 },
  "streak": { "type": "W", "length": 4 },
  "playoff_seed": 2,
  "last_updated": "2024-08-24T17:32:11Z"
}
```
Record/streak derive from schedule dataset; compute in API layer so frontend stays presentation-focused.
Notes: `slug` can be generated in API layer; confirm `logo_url` fidelity from ESPN assets.

#### Manager Profile
Synthetic layer combining team ownership + optional social handles.
```json
{
  "manager_id": "mgr_chris_g",
  "display_name": "Chris G",
  "team_ids": [3],
  "tenure": 10,
  "championships": 2,
  "chat_handle": "@chris",
  "avatar_url": "https://..."
}
```

#### Matchup
Source: `schedule.csv`, `weekly_scores_*.csv`
```json
{
  "matchup_id": "2024-11-3v4",
  "season": 2024,
  "week": 11,
  "home_team_id": 3,
  "away_team_id": 4,
  "home_score": 112.4,
  "away_score": 107.8,
  "winner": "HOME",
  "kickoff": "2024-11-10T18:00:00Z",
  "status": "LIVE",
  "projected_delta": -4.6,
  "win_probabilities": [
    { "minute": 0, "home": 0.52 },
    { "minute": 60, "home": 0.71 }
  ],
  "highlights": ["highlight_abc"],
  "notable_events": ["player_boog"]
}
```
`win_probabilities` and projections come from AI/service layer; initial version can reuse ESPN projections or simple heuristics.
Notes: `kickoff`, `status`, `projected_delta`, `win_probabilities`, `highlights`, and `notable_events` will need additional sources beyond the current CSV outputs.

#### Roster Entry
Source: `roster_enriched.csv`
```json
{
  "team_id": 3,
  "season": 2024,
  "week": 11,
  "slot": "RB",
  "espn_player_id": 15765,
  "player": {
    "player_id": "00-00312345",
    "display_name": "Bijan Robinson",
    "nfl_team": "ATL",
    "position": "RB",
    "injury_status": "ACTIVE"
  },
  "lineup_status": "STARTER",
  "acquisition_type": "DRAFT",
  "fantasy_points": 18.6,
  "score_breakdown": {
    "score_base": 16.6,
    "score_bonus": 2,
    "score_position": 0,
    "counts_for_score": true
  }
}
```

#### Player Stat Line
Source: `weekly_stats_*.csv` + scoring engine outputs.
```json
{
  "player_id": "00-00312345",
  "season": 2024,
  "week": 11,
  "team_id": 3,
  "stat_source": "nflverse",
  "stats": {
    "passing_yards": 0,
    "rushing_yards": 92,
    "receptions": 4,
    "receiving_yards": 21,
    "rushing_tds": 1,
    "fumbles_lost": 0
  },
  "fantasy_points": 18.6,
  "fantasy_points_raw": {
    "espn": 17.9,
    "custom": 18.6
  }
}
```
Notes: `fantasy_points_raw.espn` requires storing ESPN-provided fantasy totals alongside custom calculations.

#### Highlight / Moment
Generated by AI or rules engine; proposed storage `data/out/highlights/<season>/week-<n>.json` (would be a new artifact produced by backend).
```json
{
  "highlight_id": "highlight_abc",
  "season": 2024,
  "week": 11,
  "type": "clutch_td",
  "title": "Bijan bursts for the dagger",
  "summary": "With 2:14 left, Bijan's 21-yard TD flipped win probability by 34%.",
  "media": {
    "kind": "gif",
    "url": "https://cdn.fantasy.ai/highlights/abc.gif"
  },
  "associated_matchup_id": "2024-11-3v4",
  "created_at": "2024-11-10T21:04:00Z"
}
```

#### Insight / Narrative
```json
{
  "insight_id": "insight_hot_hand",
  "audience": "league",
  "season": 2024,
  "week": 11,
  "headline": "The Beasts pull off four-game heater",
  "body": "Chris' bench outscored two starters in Week 11, pushing his win streak to four and vaulting him into the #2 seed.",
  "tags": ["streak", "bench"],
  "confidence": 0.83,
  "cta": {
    "label": "View matchup",
    "href": "/matchups/2024/11?focus=3"
  }
}
```
`audience` may be `league`, `team:<id>`, or `manager:<id>` for personalization.
Notes: requires new generation service or rule engine; ensure we capture provenance/confidence alongside content.

### 3.3 Asset Pipeline (proposal)
- Standardize on canonical IDs: `espn_player_id` (int) and `player_id` (GSIS). API helper `GET /api/assets/player/:id` could return signed CDN URL.
- Backend could maintain a manifest `data/out/assets/player_manifests.json` mapping IDs to URLs + last fetch timestamp.
- For missing assets, frontend shows styled placeholder with team colors and initials.
- Logos: pull from ESPN when available; fallback pack (e.g., `public/logos/<team>.svg`) only if licensing cleared.

### 3.4 Derived Metrics & AI Interfaces (future candidates)
- `GET /api/insights/recent` could return aggregated insights, sorted by priority.
- `POST /api/insights/feedback` would let commissioners flag bad AI takes; store audit trail for tuning.
- `GET /api/matchups/:season/:week/live` could stream SSE/WebSocket for live delta (phase 2).

### 3.5 Versioning & Caching
- Include `etag` + `cache-control: max-age=30` for near-real-time routes; long-tail history can be `s-maxage=3600` once we prove stability.
- Version bump when schema changes (`metadata.schema_version`). Coordinate API versioning with CLI artifact versions.

## 4. Implementation Phases (suggested)
1. **Scaffold** Next.js app, shared UI kit, and wire API routes that read the CLI-generated artifacts.
2. **League Home MVP**: hero narrative, matchup strip, manager capsules fed directly by real CSV/JSON outputs.
3. **Data bridge**: implement API routes reading CLI CSVs, convert to contract shapes, add chosen data-fetch layer.
4. **Insights engine beta**: integrate rule-based highlights, then swap to AI service if ready.
5. **History & archives**: backfill seasons, add timeline & records modules.

## 5. Open Questions
- Authentication: continue without auth (shared secret) or integrate with Cognito/Auth0?
- Update cadence: will CLI push data on schedule (cron) or does frontend trigger runs on demand?
- Asset licensing: confirm source & terms for player headshots/logos before automating fetch.

## 6. Next Steps for Frontend
- Approve data contract naming + route scheme.
- Provide real CLI outputs covering recent matchups so we can validate the transformation layer.
- Decide on design system baseline (Tailwind vs CSS vars + utility).
- Once backend agent is ready, pair on Next API route that shells out to CLI or reads freshly generated artifacts.
