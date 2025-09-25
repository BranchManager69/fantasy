import fs from "node:fs";
import path from "node:path";

function resolveRepoRoot(): string {
  const envRoot = process.env.FANTASY_REPO_ROOT;
  if (envRoot) {
    return path.resolve(envRoot);
  }

  let current = process.cwd();
  // Walk up until we find the checked-in data artifacts directory.
  while (true) {
    if (fs.existsSync(path.join(current, "data", "out", "espn"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}

const repoRoot = resolveRepoRoot();

export const dataRoot = path.join(repoRoot, "data");

export const espnOutRoot = path.join(dataRoot, "out", "espn");

export function seasonDir(season: string | number) {
  return path.join(espnOutRoot, String(season));
}
