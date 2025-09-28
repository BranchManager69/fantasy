export type JobStatus = "idle" | "running" | "success" | "error";

export type JobSnapshot = {
  status: JobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  lastExitCode: number | null;
  error: string | null;
  log: string[];
};

export type SimulationStatusResponse = {
  datasetGeneratedAt: string | null;
  job: JobSnapshot;
};
