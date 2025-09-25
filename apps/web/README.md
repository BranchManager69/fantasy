# Fantasy League Engine – Web Workspace

Next.js App Router workspace that will surface the deterministic artifacts produced by the Python CLI. Every route will read real CSV/JSON outputs under `data/out/`; there are no mock APIs or stubs.

## Quick start

```bash
cd apps/web
npm install
npm run dev
```

The dev server runs on [http://localhost:3000](http://localhost:3000). The landing page renders project status cards and links into the UX/data-contract documentation.

## Data expectations

- Run the backend workflow (`poetry run fantasy espn pull`, `... normalize`, `fantasy espn build-week`, `fantasy score week`) so the `data/out/espn/<season>/` artifacts exist before building data-driven components.
- Upcoming API routes will live under `src/app/api/` and map directly to those artifacts (see `docs/frontend-ux-data-contract.md`).

## Scripts

- `npm run dev` – Start the Next.js dev server (no Turbopack).
- `npm run build` – Production build; automatically checks types.
- `npm run start` – Launches the production server after a build, useful for smoke-testing against real data files.

## API surface (in progress)

- `GET /api/league` – Reads the most recent `data/out/espn/<season>/teams.csv` and returns league + team metadata. Responds with `503` until the backend generates artifacts.

## Project layout

```
apps/web
├── next.config.ts
├── package.json
├── public/
└── src/
    └── app/
        ├── api/         # reserved for real data endpoints (to be added)
        ├── globals.css
        ├── layout.tsx
        └── page.tsx
```

Contribution guidelines and testing strategy will expand as UI modules land.
