import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import type { JobSnapshot } from "@/types/sim-status";

const MAX_LOG_LINES = 200;
const REPO_ROOT = path.resolve(process.cwd(), "../../");

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
  };

  private child: ChildProcess | null = null;

  get snapshot(): JobSnapshot {
    return { ...this.state, log: [...this.state.log] };
  }

  get isRunning(): boolean {
    return this.state.status === "running";
  }

  start(): JobSnapshot {
    if (this.isRunning) {
      throw new Error("Simulation already running");
    }

    const startedAt = nowISO();
    this.state = {
      status: "running",
      startedAt,
      finishedAt: null,
      lastExitCode: null,
      error: null,
      log: [],
    };

    const child = spawn("bash", ["-lc", "npm run refresh-all && poetry run fantasy sim rest-of-season --simulations 500"], {
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
