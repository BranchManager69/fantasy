import fs from "node:fs";
import path from "node:path";
// Tenant header resolution via middleware is supported but optional.
// To avoid build-time issues, we do not call headers() here.
import { hostToLeagueSlug, defaultLeagueSlug } from "@/lib/league-host";

let cachedRepoRoot: string | null = null;
export function getRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;
  const envRoot = process.env.FANTASY_REPO_ROOT;
  if (envRoot) {
    cachedRepoRoot = path.resolve(envRoot);
    return cachedRepoRoot;
  }
  let current = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(current, "data", "out", "espn"))) {
      cachedRepoRoot = current;
      return cachedRepoRoot;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      cachedRepoRoot = process.cwd();
      return cachedRepoRoot;
    }
    current = parent;
  }
}

export function getDataRoot(): string {
  // Resolve via env (tenant-aware) first; fall back to repo data/
  const defaultSlug = defaultLeagueSlug();
  // Middleware should set x-fantasy-league-slug and service code can map it to env if needed.
  // Here, we only consult env so this is safe at build time.
  const perTenant = Object.entries(process.env).find(([k]) => k.startsWith("FANTASY_DATA_ROOT__"));
  if (perTenant) {
    // If any per-tenant roots are configured and a default is provided, prefer the default mapping.
    const def = process.env[`FANTASY_DATA_ROOT__${defaultSlug}`];
    if (def) return path.resolve(def);
  }
  const envData = process.env.DATA_ROOT;
  if (envData) return path.resolve(envData);
  return path.join(getRepoRoot(), "data");
}

export function getEspnOutRoot(): string {
  return path.join(getDataRoot(), "out", "espn");
}

export function getSimulationsOutRoot(): string {
  return path.join(getDataRoot(), "out", "simulations");
}

export function getHistoryRoot(): string {
  return path.join(getDataRoot(), "history");
}

export function getEspnRawRoot(): string {
  return path.join(getDataRoot(), "raw", "espn");
}

export function scoreboardPath(season: string | number, week: string | number): string {
  return path.join(getEspnRawRoot(), String(season), `view-mScoreboard-week-${week}.json`);
}

export function seasonDir(season: string | number) {
  return path.join(getEspnOutRoot(), String(season));
}

export function simulationSeasonDir(season: string | number) {
  return path.join(getSimulationsOutRoot(), String(season));
}

export function simulationHistorySeasonDir(season: string | number) {
  return path.join(getHistoryRoot(), "simulations", String(season));
}

export function refreshDiffLogPath(): string {
  return path.join(getHistoryRoot(), "refresh-diff.log");
}
