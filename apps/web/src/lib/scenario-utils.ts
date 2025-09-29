import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";

export type ScenarioSearchParam = string | string[] | undefined;

export function normalizeScenarioId(value: ScenarioSearchParam): string {
  if (Array.isArray(value)) {
    return normalizeScenarioId(value[0]);
  }
  if (!value) {
    return BASELINE_SCENARIO_ID;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : BASELINE_SCENARIO_ID;
}
