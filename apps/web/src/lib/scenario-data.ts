import { promises as fs } from "node:fs";
import path from "node:path";

import { getDataRoot } from "@/lib/paths";
import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";
import type { ScenarioOption } from "@/types/scenario";

const overlaysRoot = path.join(getDataRoot(), "overlays");

function parseWeekKeys(record: unknown): number[] {
  if (!record || typeof record !== "object") return [];
  return Object.keys(record)
    .map((key) => Number(key))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

async function readScenarioFile(filePath: string, season: number): Promise<ScenarioOption | null> {
  try {
    const contents = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(contents) as Record<string, unknown>;
    const scenarioIdRaw = typeof parsed.scenario_id === "string" && parsed.scenario_id.trim().length > 0
      ? parsed.scenario_id.trim()
      : path.basename(filePath, path.extname(filePath));
    const scenarioId = scenarioIdRaw.trim();
    const label = typeof parsed.label === "string" && parsed.label.trim().length > 0 ? parsed.label.trim() : scenarioId;
    const description = typeof parsed.description === "string" && parsed.description.trim().length > 0 ? parsed.description.trim() : null;
    const updatedAt = typeof parsed.updated_at === "string" && parsed.updated_at.trim().length > 0 ? parsed.updated_at.trim() : null;
    const completedWeeksRaw = parseWeekKeys(parsed.completed_weeks);
    const projectionWeeksRaw = parseWeekKeys((parsed as { projection_weeks?: unknown; projections?: unknown }).projection_weeks ?? (parsed as { projections?: unknown }).projections);

    return {
      id: scenarioId,
      label,
      description,
      season,
      isBaseline: scenarioId.toLowerCase() === BASELINE_SCENARIO_ID,
      updatedAt,
      overrides: {
        completedWeeks: completedWeeksRaw,
        projectionWeeks: projectionWeeksRaw,
      },
    };
  } catch {
    return null;
  }
}

function baselineScenario(season: number): ScenarioOption {
  return {
    id: BASELINE_SCENARIO_ID,
    label: "Baseline",
    description: "Official ESPN dataset",
    season,
    isBaseline: true,
    updatedAt: null,
    overrides: {
      completedWeeks: [],
      projectionWeeks: [],
    },
  };
}

export async function listScenarios(season: number): Promise<ScenarioOption[]> {
  const results: ScenarioOption[] = [];
  const seasonDir = path.join(overlaysRoot, String(season));
  try {
    const entries = await fs.readdir(seasonDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const meta = await readScenarioFile(path.join(seasonDir, entry.name), season);
      if (meta && !meta.isBaseline) {
        results.push(meta);
      }
    }
  } catch {
    // ignore missing directories
  }

  results.sort((a, b) => a.label.localeCompare(b.label));
  return [baselineScenario(season), ...results];
}
