export type JobStatus = "idle" | "running" | "success" | "error";

export type JobSnapshot = {
  status: JobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  lastExitCode: number | null;
  error: string | null;
  log: string[];
  scenarioId: string | null;
};

export type ScenarioSummary = {
  id: string;
  label: string;
  season: number;
  is_baseline: boolean;
  overrides?: {
    completed_weeks: number[];
    projection_weeks: number[];
  };
  description?: string;
  updated_at?: string;
} | null;

export type SimulationStatusResponse = {
  datasetGeneratedAt: string | null;
  job: JobSnapshot;
  scenario: ScenarioSummary;
};
