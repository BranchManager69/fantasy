"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { formatTimestamp } from "@/lib/formatters";
import type { JobSnapshot, SimulationStatusResponse } from "@/types/sim-status";

const POLL_INTERVAL_MS = 5000;

const INITIAL_STATUS: SimulationStatusResponse = {
  datasetGeneratedAt: null,
  job: {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    lastExitCode: null,
    error: null,
    log: [],
    scenarioId: null,
  },
  scenario: null,
};

function describeJob(job: JobSnapshot): string {
  switch (job.status) {
    case "running":
      return job.startedAt ? `Refresh in progress (started ${formatTimestamp(job.startedAt)})` : "Refresh in progress";
    case "success":
      return job.finishedAt ? `Last refresh succeeded ${formatTimestamp(job.finishedAt)}` : "Last refresh succeeded";
    case "error":
      return job.finishedAt
        ? `Last refresh failed ${formatTimestamp(job.finishedAt)}${job.error ? ` – ${job.error}` : ""}`
        : job.error ?? "Last refresh failed";
    default:
      return "Refresh queue idle";
  }
}

type Props = {
  initialGeneratedAt: string | null;
  scenarioId: string;
};

export function RefreshControls({ initialGeneratedAt, scenarioId }: Props) {
  const [status, setStatus] = useState<SimulationStatusResponse>({
    ...INITIAL_STATUS,
    datasetGeneratedAt: initialGeneratedAt,
    job: { ...INITIAL_STATUS.job, scenarioId },
  });
  const [isTriggering, setIsTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const query = scenarioId ? `?scenario=${encodeURIComponent(scenarioId)}` : "";
      const response = await fetch(`/api/sim/rest-of-season/status${query}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Status request failed (${response.status})`);
      }
      const data = (await response.json()) as SimulationStatusResponse;
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to fetch refresh status");
    }
  }, [scenarioId]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const triggerRefresh = useCallback(async () => {
    if (isTriggering) return;
    setIsTriggering(true);
    setError(null);
    try {
      const query = scenarioId ? `?scenario=${encodeURIComponent(scenarioId)}` : "";
      const response = await fetch(`/api/sim/rest-of-season/trigger${query}`, { method: "POST" });
      if (response.status === 409) {
        const payload = await response.json().catch(() => ({ error: "Simulation already running." }));
        setError(payload.error ?? "Simulation already running.");
      } else if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error((payload as { error?: string }).error ?? `Failed to start refresh (${response.status})`);
      } else {
        const snapshot = (await response.json()) as JobSnapshot;
        setStatus((prev) => ({ ...prev, job: snapshot }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start refresh");
    } finally {
      setIsTriggering(false);
      fetchStatus();
    }
  }, [fetchStatus, isTriggering, scenarioId]);

  const lastGeneratedCopy = useMemo(() => {
    if (!status.datasetGeneratedAt) return "Unknown";
    return formatTimestamp(status.datasetGeneratedAt);
  }, [status.datasetGeneratedAt]);

  const jobDescription = useMemo(() => describeJob(status.job), [status.job]);
  const buttonDisabled = isTriggering || status.job.status === "running";

  return (
    <div className="refresh-controls">
      <div className="refresh-controls__meta">
        <span className="refresh-controls__label">Last generated</span>
        <span className="refresh-controls__value">{lastGeneratedCopy}</span>
      </div>
      <div className="refresh-controls__meta">
        <span className="refresh-controls__label">Status</span>
        <span className={`refresh-controls__value refresh-controls__value--${status.job.status}`}>
          {jobDescription}
        </span>
        {error ? <span className="refresh-controls__error">{error}</span> : null}
      </div>
      <button
        type="button"
        className="refresh-controls__button"
        onClick={triggerRefresh}
        disabled={buttonDisabled}
      >
        {status.job.status === "running" ? "Refreshing…" : "Run refresh"}
      </button>
    </div>
  );
}
