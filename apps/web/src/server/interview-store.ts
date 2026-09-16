import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type InterviewStatus =
  | "preparing" | "ready" | "dialing" | "queued" | "ringing" | "in-progress"
  | "completed" | "busy" | "no-answer" | "canceled" | "failed" | "unknown";

export type InterviewRunFields = {
  status?: InterviewStatus;
  callSid?: string;
  model?: string;
  backendModel?: string;
  voice?: string;
  sourceRevision?: string;
  callerLast4?: string;
  recipientLast4?: string;
  briefPath?: string;
  transcriptPath?: string;
  liveSessionId?: string;
  failure?: { code: string; message: string };
  errorCode?: string;
  finalUsage?: unknown;
  finalized?: boolean;
  audioMs?: number;
  metadata?: Record<string, unknown>;
};

export type InterviewReservation = { requestId: string; season: number; week: number; teamId: number };
export type InterviewRun = InterviewRunFields & InterviewReservation & {
  version: 1;
  id: string;
  status: InterviewStatus;
  createdAt: string;
  updatedAt: string;
  dialAttemptedAt?: string;
  finishedAt?: string;
};
export type InterviewEvent = { type: string; [key: string]: unknown };
export type InterviewStoreErrorCode = "busy" | "daily_limit" | "invalid_request" | "invalid_run" | "conflict" | "unavailable";

export class InterviewStoreError extends Error {
  constructor(readonly code: InterviewStoreErrorCode, message: string) {
    super(message);
    this.name = "InterviewStoreError";
  }
}

type Ledger = { version: 1; attempts: Record<string, string> };
const TERMINAL = new Set<InterviewStatus>(["completed", "busy", "no-answer", "canceled", "failed"]);
const DIAL_STATES = new Set<InterviewStatus>(["dialing", "queued", "ringing", "in-progress", "unknown"]);
const RANK: Partial<Record<InterviewStatus, number>> = { preparing: 0, ready: 1, dialing: 2, queued: 3, ringing: 4, "in-progress": 5 };
const STATUSES = new Set<InterviewStatus>([...TERMINAL, ...DIAL_STATES, "preparing", "ready"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const queues = new Map<string, Promise<unknown>>();

function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function invalid(message: string): never { throw new InterviewStoreError("invalid_request", message); }
function unavailable(): never { throw new InterviewStoreError("unavailable", "The interview record cannot be read safely."); }
function validateId(id: string): void { if (!UUID.test(id)) invalid("Invalid interview identifier."); }
function validTime(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }

function validateReservation(input: InterviewReservation): void {
  if (!input || typeof input.requestId !== "string" || !TOKEN.test(input.requestId)) invalid("Use a short request identifier containing letters, numbers, dots, underscores, or hyphens.");
  if (!Number.isInteger(input.season) || input.season < 2000 || input.season > 2200
    || !Number.isInteger(input.week) || input.week < 1 || input.week > 22
    || !Number.isInteger(input.teamId) || input.teamId < 1 || input.teamId > 1000) invalid("Invalid interview season, week, or team.");
}

function safeText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) invalid("Invalid interview metadata.");
  return value.replace(/\+\d{7,15}\b/g, "[phone redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[key redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
}

/** Metadata and events may contain transcripts, but never credential or recipient fields. */
function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 6) invalid("Interview metadata is too deeply nested.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return safeText(value, 16_000);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 256) invalid("Too many interview metadata entries.");
    return value.map((entry) => safeValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object") invalid("Invalid interview metadata value.");
  const entries = Object.entries(value);
  if (entries.length > 128) invalid("Too many interview metadata fields.");
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (item === undefined) continue;
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    if (["__proto__", "constructor", "prototype"].includes(key)
      || /^(apikey|key|secret|password|authorization|authtoken|accesstoken|refreshtoken|token|cookie|phone|phonenumber|recipient|caller|to|from)$/.test(normalized)
      || normalized.includes("credential") || normalized.startsWith("twilioauth")) continue;
    if (key.length > 100) invalid("Invalid interview metadata field.");
    result[key] = safeValue(item, depth + 1);
  }
  return result;
}

function sanitizedPatch(patch: InterviewRunFields): InterviewRunFields {
  const result: InterviewRunFields = {};
  if (patch.status !== undefined) {
    if (!STATUSES.has(patch.status)) invalid("Invalid interview status.");
    result.status = patch.status;
  }
  for (const key of ["model", "backendModel", "voice", "sourceRevision", "briefPath", "transcriptPath", "liveSessionId", "errorCode"] as const) {
    if (patch[key] !== undefined) result[key] = safeText(patch[key], 512);
  }
  if (patch.callSid !== undefined) {
    if (!/^CA[a-fA-F0-9]{32}$/.test(patch.callSid)) invalid("Invalid call identifier.");
    result.callSid = patch.callSid;
  }
  for (const key of ["callerLast4", "recipientLast4"] as const) {
    if (patch[key] !== undefined) {
      if (!/^\d{4}$/.test(patch[key])) invalid("Only the final four phone digits may be stored.");
      result[key] = patch[key];
    }
  }
  if (patch.failure !== undefined) {
    if (!patch.failure || !TOKEN.test(patch.failure.code)) invalid("Invalid interview failure code.");
    result.failure = { code: patch.failure.code, message: safeText(patch.failure.message, 2000) };
  }
  if (patch.finalized !== undefined) {
    if (typeof patch.finalized !== "boolean") invalid("Invalid interview completion flag.");
    result.finalized = patch.finalized;
  }
  if (patch.audioMs !== undefined) {
    if (!Number.isFinite(patch.audioMs) || patch.audioMs < 0) invalid("Invalid interview audio duration.");
    result.audioMs = patch.audioMs;
  }
  if (patch.finalUsage !== undefined) result.finalUsage = safeValue(patch.finalUsage);
  if (patch.metadata !== undefined) {
    if (!patch.metadata || typeof patch.metadata !== "object" || Array.isArray(patch.metadata)) invalid("Interview metadata must be an object.");
    result.metadata = safeValue(patch.metadata) as Record<string, unknown>;
  }
  if (JSON.stringify(result).length > 64_000) invalid("Interview metadata is too large.");
  return result;
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable();
  await fs.chmod(directory, 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try { await fs.rename(temporary, file); await syncDirectory(path.dirname(file)); }
  finally { await fs.unlink(temporary).catch((error) => { if (code(error) !== "ENOENT") throw error; }); }
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) unavailable();
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    if (error instanceof InterviewStoreError) throw error;
    unavailable();
  }
}

/** One service process writes this store; the durable lock also survives its restart. */
export class InterviewStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly dailyLimit: number;

  constructor(root: string, options: { now?: () => Date; dailyLimit?: number } = {}) {
    this.root = path.resolve(root);
    this.now = options.now ?? (() => new Date());
    this.dailyLimit = Number(options.dailyLimit ?? process.env.FANTASY_INTERVIEW_DAILY_LIMIT ?? 3);
    if (!Number.isInteger(this.dailyLimit) || this.dailyLimit < 0 || this.dailyLimit > 20) invalid("Interview daily limit must be an integer between zero and twenty.");
  }

  private get lock(): string { return path.join(this.root, "active.lock"); }
  private runFile(id: string): string { validateId(id); return path.join(this.root, "runs", `${id}.json`); }
  private async initialized(): Promise<void> {
    await privateDirectory(this.root);
    for (const directory of ["runs", "requests", "events"]) await privateDirectory(path.join(this.root, directory));
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const prior = queues.get(this.root) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    queues.set(this.root, current);
    void current.finally(() => { if (queues.get(this.root) === current) queues.delete(this.root); }).catch(() => undefined);
    return current;
  }

  private async ledger(): Promise<Ledger> {
    const raw = await readJson(path.join(this.root, "ledger.json"));
    if (raw === null) {
      // A lost ledger must never replenish an existing history's allowance.
      let files: string[];
      try { files = await fs.readdir(path.join(this.root, "runs")); }
      catch (error) { if (code(error) !== "ENOENT") throw error; files = []; }
      if (files.some((name) => name.endsWith(".json"))) unavailable();
      return { version: 1, attempts: {} };
    }
    const value = raw as Ledger;
    if (value.version !== 1 || !value.attempts || typeof value.attempts !== "object" || Array.isArray(value.attempts)) unavailable();
    for (const [id, at] of Object.entries(value.attempts)) if (!UUID.test(id) || !validTime(at)) unavailable();
    return value;
  }

  private used(ledger: Ledger, at: string): number {
    return Object.values(ledger.attempts).filter((value) => value.slice(0, 10) === at.slice(0, 10)).length;
  }

  async find(id: string): Promise<InterviewRun | null> {
    const raw = await readJson(this.runFile(id));
    if (raw === null) return null;
    const run = raw as InterviewRun;
    if (run.version !== 1 || run.id !== id || !STATUSES.has(run.status) || !validTime(run.createdAt) || !validTime(run.updatedAt)) unavailable();
    try { validateReservation(run); } catch { unavailable(); }
    return run;
  }

  async reserve(input: InterviewReservation): Promise<{ run: InterviewRun; existing: boolean }> {
    validateReservation(input);
    return this.serial(async () => {
      await this.initialized();
      const requestFile = path.join(this.root, "requests", `${input.requestId}.json`);
      const duplicate = await readJson(requestFile) as { runId?: string } | null;
      if (duplicate) {
        if (typeof duplicate.runId !== "string" || !UUID.test(duplicate.runId)) unavailable();
        const run = await this.find(duplicate.runId);
        if (!run) unavailable();
        if (run.requestId !== input.requestId || run.season !== input.season || run.week !== input.week || run.teamId !== input.teamId) {
          throw new InterviewStoreError("conflict", "That request identifier already belongs to another interview.");
        }
        return { run, existing: true };
      }
      try { await fs.mkdir(this.lock, { mode: 0o700 }); }
      catch (error) {
        if (code(error) === "EEXIST") throw new InterviewStoreError("busy", "An interview is already active or awaiting confirmation of its outcome.");
        throw error;
      }
      // Unexpected errors after acquiring the lock remain blocked for inspection.
      // No timeout or process restart clears an uncertain outbound request.
      const ledger = await this.ledger();
      const createdAt = this.now().toISOString();
      if (this.used(ledger, createdAt) >= this.dailyLimit) {
        await fs.rmdir(this.lock);
        throw new InterviewStoreError("daily_limit", "Today's interview call limit has been reached.");
      }
      const run: InterviewRun = {
        requestId: input.requestId, season: input.season, week: input.week, teamId: input.teamId,
        version: 1, id: randomUUID(), status: "preparing", createdAt, updatedAt: createdAt,
      };
      await atomicJson(path.join(this.lock, "owner.json"), { runId: run.id, requestId: run.requestId });
      await atomicJson(path.join(this.root, "ledger.json"), ledger);
      await atomicJson(this.runFile(run.id), run);
      await atomicJson(requestFile, { runId: run.id });
      return { run, existing: false };
    });
  }

  private nextStatus(current: InterviewStatus, requested?: InterviewStatus): InterviewStatus {
    if (!requested || TERMINAL.has(current)) return current;
    if (TERMINAL.has(requested)) return requested;
    if (current === "unknown") return ["queued", "ringing", "in-progress"].includes(requested) ? requested : current;
    if (requested === "unknown") return requested;
    return (RANK[requested] ?? -1) >= (RANK[current] ?? -1) ? requested : current;
  }

  private async release(id: string): Promise<void> {
    const owner = await readJson(path.join(this.lock, "owner.json")) as { runId?: string } | null;
    if (!owner || owner.runId !== id) return;
    await fs.unlink(path.join(this.lock, "owner.json"));
    await fs.rmdir(this.lock);
    await syncDirectory(this.root);
  }

  async update(id: string, patch: InterviewRunFields): Promise<InterviewRun> {
    validateId(id);
    const fields = sanitizedPatch(patch);
    return this.serial(async () => {
      const current = await this.find(id);
      if (!current) throw new InterviewStoreError("invalid_run", "Interview was not found.");
      if (!TERMINAL.has(current.status)) {
        const owner = await readJson(path.join(this.lock, "owner.json")) as { runId?: string } | null;
        if (owner?.runId !== id) throw new InterviewStoreError("unavailable", "The interview no longer owns its active reservation.");
      }
      if (current.callSid && fields.callSid && current.callSid !== fields.callSid) {
        throw new InterviewStoreError("conflict", "An interview cannot change its call identifier.");
      }
      const status = this.nextStatus(current.status, fields.status);
      const updatedAt = this.now().toISOString();
      const run: InterviewRun = { ...current, ...fields, status, updatedAt };
      if (current.finalized) run.finalized = true;
      if (fields.metadata) run.metadata = { ...current.metadata, ...fields.metadata };
      if (JSON.stringify(run).length > 128_000) invalid("Interview record is too large.");
      if (DIAL_STATES.has(status) && !current.dialAttemptedAt) {
        const ledger = await this.ledger();
        if (!ledger.attempts[id]) {
          if (this.used(ledger, updatedAt) >= this.dailyLimit) throw new InterviewStoreError("daily_limit", "Today's interview call limit has been reached.");
          ledger.attempts[id] = updatedAt;
          // Record before a caller is allowed to contact Twilio, including failures.
          await atomicJson(path.join(this.root, "ledger.json"), ledger);
        }
        run.dialAttemptedAt = ledger.attempts[id];
      }
      if (TERMINAL.has(status)) run.finishedAt = current.finishedAt ?? updatedAt;
      await atomicJson(this.runFile(id), run);
      if (TERMINAL.has(status)) await this.release(id);
      return run;
    });
  }

  async list(limit = 20): Promise<InterviewRun[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid("Interview list limit must be between one and two hundred.");
    let names: string[];
    try { names = await fs.readdir(path.join(this.root, "runs")); }
    catch (error) { if (code(error) === "ENOENT") return []; throw error; }
    const runs: InterviewRun[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) continue;
      const run = await this.find(name.slice(0, -5));
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit);
  }

  async markEvent(id: string, event: InterviewEvent): Promise<void> {
    validateId(id);
    if (!event || typeof event.type !== "string" || !TOKEN.test(event.type)) invalid("Invalid interview event type.");
    const clean = safeValue(event) as Record<string, unknown>;
    const line = JSON.stringify({ ...clean, runId: id, at: this.now().toISOString() }) + "\n";
    if (Buffer.byteLength(line) > 64_000) invalid("Interview event is too large.");
    return this.serial(async () => {
      if (!await this.find(id)) throw new InterviewStoreError("invalid_run", "Interview was not found.");
      const file = path.join(this.root, "events", `${id}.jsonl`);
      const handle = await fs.open(file, "a", 0o600);
      try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
    });
  }
}
