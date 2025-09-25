import path from "node:path";

const repoRoot = path.resolve(process.cwd(), "..", "..");

export const dataRoot = path.join(repoRoot, "data");

export const espnOutRoot = path.join(dataRoot, "out", "espn");

export function seasonDir(season: string | number) {
  return path.join(espnOutRoot, String(season));
}
