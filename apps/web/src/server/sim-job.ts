import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import type { JobSnapshot } from "@/types/sim-status";

const MAX_LOG_LINES = 200;
const REPO_ROOT = path.resolve(process.cwd(), "../../");
const BASELINE_SCENARIO_ID = "baseline";

function shellEscape(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

function buildSimCommand(scenarioId?: string | null): string {
// `npm run refresh-all` auto-detects the active matchup period and projection window,
// so we keep the command free of hard-coded week arguments.
const baseCommand = "npm run refresh-all && poetry run fantasy sim rest-of-season --simulations 500";
  if (!scenarioId || scenarioId.toLowerCase() === BASELINE_SCENARIO_ID) {
    return baseCommand;
  }
  return `${baseCommand} --scenario ${shellEscape(scenarioId)}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

class SimulationJobRunner {
  private state: JobSnapshot = {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    lastExitCode: null,
    error: null,
    log: [],
    scenarioId: null,
  };

  private child: ChildProcess | null = null;

  get snapshot(): JobSnapshot {
    return { ...this.state, log: [...this.state.log] };
  }

  get isRunning(): boolean {
    return this.state.status === "running";
  }

  start(scenarioId?: string | null): JobSnapshot {
    if (this.isRunning) {
      throw new Error("Simulation already running");
    }

    const trimmedScenario = scenarioId?.trim() ?? null;
    const baseline = !trimmedScenario || trimmedScenario.toLowerCase() === BASELINE_SCENARIO_ID;
    const scenarioForCommand = baseline ? null : trimmedScenario;
    const activeScenarioId = baseline ? BASELINE_SCENARIO_ID : trimmedScenario;
    const startedAt = nowISO();
    this.state = {
      status: "running",
      startedAt,
      finishedAt: null,
      lastExitCode: null,
      error: null,
      log: [],
      scenarioId: activeScenarioId,
    };

    const command = buildSimCommand(scenarioForCommand);
    this.state.log.push(`Starting refresh${baseline ? " (baseline)" : ` (scenario: ${activeScenarioId})`}`);
    if (this.state.log.length > MAX_LOG_LINES) {
      this.state.log.splice(0, this.state.log.length - MAX_LOG_LINES);
    }

    const child = spawn("bash", ["-lc", command], {
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child = child;

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.state.log.push(line);
        if (this.state.log.length > MAX_LOG_LINES) {
          this.state.log.splice(0, this.state.log.length - MAX_LOG_LINES);
        }
      }
    };

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);

    child.on("error", (error) => {
      this.state = {
        status: "error",
        startedAt,
        finishedAt: nowISO(),
        lastExitCode: null,
        error: error.message,
        log: [...this.state.log, `ERROR: ${error.message}`].slice(-MAX_LOG_LINES),
        scenarioId: activeScenarioId,
      };
      this.child = null;
    });

    child.on("close", (code, signal) => {
      const finishedAt = nowISO();
      if (code === 0) {
        this.state = {
          status: "success",
          startedAt,
          finishedAt,
          lastExitCode: 0,
          error: null,
          log: this.state.log,
          scenarioId: activeScenarioId,
        };
      } else {
        const error = signal
          ? `terminated by signal ${signal}`
          : `exited with code ${code ?? "unknown"}`;
        this.state = {
          status: "error",
          startedAt,
          finishedAt,
          lastExitCode: code ?? null,
          error,
          log: [...this.state.log, `ERROR: ${error}`].slice(-MAX_LOG_LINES),
          scenarioId: activeScenarioId,
        };
      }
      this.child = null;
    });

    return this.snapshot;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __fantasySimJobRunner: SimulationJobRunner | undefined;
}

export const simJobRunner: SimulationJobRunner =
  globalThis.__fantasySimJobRunner ?? (globalThis.__fantasySimJobRunner = new SimulationJobRunner());

export function getJobSnapshot(): JobSnapshot {
  return simJobRunner.snapshot;
}
