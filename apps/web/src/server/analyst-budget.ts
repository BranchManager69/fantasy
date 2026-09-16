import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type AnalystBudgetStatus = { remaining: number; dailyLimit: number; busy: boolean };
export type AnalystBudgetErrorCode =
  | "busy" | "daily_limit" | "invalid_limit" | "unavailable" | "invalid_receipt" | "cleanup_required";

export class AnalystBudgetError extends Error {
  readonly code: AnalystBudgetErrorCode;

  constructor(code: AnalystBudgetErrorCode, message: string) {
    super(message);
    this.name = "AnalystBudgetError";
    this.code = code;
  }
}

export type AnalystRunFields = {
  sessionId?: string;
  turnId?: string;
  status?: string;
  usage?: unknown;
  toolNames?: string[];
  cleanupVerified?: boolean;
};

export type AnalystRunReceipt = AnalystRunFields & {
  version: 1;
  runId: string;
  day: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  noRemoteSessionCreated?: boolean;
};

type Ledger = { version: 1; days: Record<string, number> };
type NumericUsage = { [key: string]: number | NumericUsage };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function resolveLimit(value: number | string | undefined): number {
  const limit = value === undefined || value === "" ? 6 : Number(value);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new AnalystBudgetError("invalid_limit", "Analyst daily limit must be a nonnegative integer.");
  }
  return Math.min(limit, 20);
}

function identifier(value: unknown, field: string, maxLength = 160): string {
  if (typeof value !== "string" || value.length > maxLength || !/^[a-zA-Z0-9_./:-]+$/.test(value)) {
    throw new AnalystBudgetError("invalid_receipt", `Invalid analyst ${field}.`);
  }
  return value;
}

function numericUsage(value: unknown, depth = 0): NumericUsage {
  if (depth > 3 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new AnalystBudgetError("invalid_receipt", "Analyst usage must contain numeric counters only.");
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new AnalystBudgetError("invalid_receipt", "Too many analyst usage counters.");
  const result: NumericUsage = {};
  for (const [key, counter] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key)) {
      throw new AnalystBudgetError("invalid_receipt", "Invalid analyst usage counter.");
    }
    if (typeof counter === "number" && Number.isFinite(counter) && counter >= 0) result[key] = counter;
    else if (counter !== null && typeof counter === "object") result[key] = numericUsage(counter, depth + 1);
    else throw new AnalystBudgetError("invalid_receipt", "Analyst usage must contain numeric counters only.");
  }
  return result;
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** One instance may be created per request; the filesystem enforces global limits. */
export class AnalystBudget {
  private readonly directory: string;
  private readonly now: () => Date;
  private readonly dailyLimit: number;

  constructor(options: { directory: string; now?: () => Date; dailyLimit?: number }) {
    this.directory = path.resolve(options.directory);
    this.now = options.now ?? (() => new Date());
    this.dailyLimit = resolveLimit(options.dailyLimit ?? process.env.FANTASY_ANALYST_DAILY_LIMIT);
  }

  private get lockDirectory(): string { return path.join(this.directory, "active.lock"); }
  private get ledgerPath(): string { return path.join(this.directory, "ledger.json"); }

  private async readLedger(): Promise<Ledger> {
    let raw: unknown;
    try { raw = JSON.parse(await fs.readFile(this.ledgerPath, "utf8")); }
    catch (error) {
      if (errorCode(error) === "ENOENT") {
        try {
          if ((await fs.readdir(path.join(this.directory, "runs"))).length > 0) {
            throw new AnalystBudgetError("unavailable", "Analyst ledger is missing while run receipts exist.");
          }
        } catch (receiptError) {
          if (errorCode(receiptError) !== "ENOENT") throw receiptError;
        }
        return { version: 1, days: {} };
      }
      throw new AnalystBudgetError("unavailable", "Analyst budget ledger cannot be read.");
    }
    const ledger = raw as Ledger;
    if (ledger?.version !== 1 || !ledger.days || typeof ledger.days !== "object" || Array.isArray(ledger.days)) {
      throw new AnalystBudgetError("unavailable", "Analyst budget ledger is invalid.");
    }
    for (const [day, count] of Object.entries(ledger.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(count) || count < 0) {
        throw new AnalystBudgetError("unavailable", "Analyst budget ledger is invalid.");
      }
    }
    return ledger;
  }

  async status(): Promise<AnalystBudgetStatus> {
    const ledger = await this.readLedger();
    let busy = false;
    try { await fs.lstat(this.lockDirectory); busy = true; }
    catch (error) {
      if (errorCode(error) !== "ENOENT") throw new AnalystBudgetError("unavailable", "Analyst lock cannot be inspected.");
    }
    const used = ledger.days[this.now().toISOString().slice(0, 10)] ?? 0;
    return { remaining: Math.max(0, this.dailyLimit - used), dailyLimit: this.dailyLimit, busy };
  }

  async reserve(): Promise<string> {
    await fs.mkdir(path.join(this.directory, "runs"), { recursive: true, mode: 0o700 });
    try { await fs.mkdir(this.lockDirectory, { mode: 0o700 }); }
    catch (error) {
      if (errorCode(error) === "EEXIST") throw new AnalystBudgetError("busy", "An analyst request is already active. Please try again later.");
      throw new AnalystBudgetError("unavailable", "The analyst cannot start a request right now.");
    }

    // From here, unexpected errors leave the lock in place. A process crash or an
    // ambiguous remote outcome must never silently permit another charged run.
    const ledger = await this.readLedger();
    const createdAt = this.now().toISOString();
    const day = createdAt.slice(0, 10);
    if ((ledger.days[day] ?? 0) >= this.dailyLimit) {
      await fs.rmdir(this.lockDirectory);
      throw new AnalystBudgetError("daily_limit", "The analyst has reached today's request limit.");
    }
    const runId = randomUUID();
    await atomicJson(path.join(this.lockDirectory, "owner.json"), { runId });
    ledger.days[day] = (ledger.days[day] ?? 0) + 1;
    await atomicJson(this.ledgerPath, ledger);
    const receipt: AnalystRunReceipt = {
      version: 1, runId, day, createdAt, updatedAt: createdAt, status: "reserved", cleanupVerified: false,
    };
    await atomicJson(path.join(this.directory, "runs", `${runId}.json`), receipt);
    return runId;
  }

  private async mutateRun<T>(runId: string, callback: (receipt: AnalystRunReceipt) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f-]{36}$/.test(runId)) throw new AnalystBudgetError("invalid_receipt", "Invalid analyst run identifier.");
    const updateLock = path.join(this.lockDirectory, "update.lock");
    try { await fs.mkdir(updateLock); }
    catch (error) {
      throw new AnalystBudgetError("unavailable", errorCode(error) === "EEXIST"
        ? "Analyst receipt is already being updated." : "No active analyst reservation was found.");
    }
    try {
      const owner = JSON.parse(await fs.readFile(path.join(this.lockDirectory, "owner.json"), "utf8"));
      if (owner.runId !== runId) throw new AnalystBudgetError("invalid_receipt", "Analyst run does not own the active lock.");
      const receipt = JSON.parse(await fs.readFile(path.join(this.directory, "runs", `${runId}.json`), "utf8")) as AnalystRunReceipt;
      if (receipt.version !== 1 || receipt.runId !== runId) throw new AnalystBudgetError("invalid_receipt", "Analyst receipt is invalid.");
      return await callback(receipt);
    } finally {
      await fs.rmdir(updateLock);
    }
  }

  async record(runId: string, fields: AnalystRunFields): Promise<void> {
    await this.mutateRun(runId, async (receipt) => {
      if (fields.sessionId !== undefined) {
        const sessionId = identifier(fields.sessionId, "session identifier");
        if (receipt.sessionId && receipt.sessionId !== sessionId) throw new AnalystBudgetError("invalid_receipt", "An analyst run cannot change sessions.");
        receipt.sessionId = sessionId;
      }
      if (fields.turnId !== undefined) receipt.turnId = identifier(fields.turnId, "turn identifier");
      if (fields.status !== undefined) receipt.status = identifier(fields.status, "status", 80);
      if (fields.usage !== undefined) receipt.usage = fields.usage === null ? null : numericUsage(fields.usage);
      if (fields.toolNames !== undefined) {
        if (!Array.isArray(fields.toolNames) || fields.toolNames.length > 64) throw new AnalystBudgetError("invalid_receipt", "Too many analyst tool names.");
        receipt.toolNames = [...new Set(fields.toolNames.map((name) => identifier(name, "tool name", 100)))];
      }
      if (fields.cleanupVerified !== undefined) {
        if (typeof fields.cleanupVerified !== "boolean") throw new AnalystBudgetError("invalid_receipt", "Invalid cleanup verification.");
        receipt.cleanupVerified = fields.cleanupVerified;
      }
      receipt.updatedAt = this.now().toISOString();
      await atomicJson(path.join(this.directory, "runs", `${runId}.json`), receipt);
    });
  }

  async finish(runId: string, proof: { cleanupVerified?: boolean; noRemoteSessionCreated?: boolean }): Promise<void> {
    await this.mutateRun(runId, async (receipt) => {
      const cleaned = proof.cleanupVerified === true || receipt.cleanupVerified === true;
      const neverCreated = proof.noRemoteSessionCreated === true && !receipt.sessionId;
      if (!cleaned && !neverCreated) {
        throw new AnalystBudgetError("cleanup_required", "The previous analyst session must be confirmed closed before another request can start.");
      }
      receipt.cleanupVerified = cleaned;
      receipt.noRemoteSessionCreated = neverCreated;
      receipt.finishedAt = receipt.updatedAt = this.now().toISOString();
      await atomicJson(path.join(this.directory, "runs", `${runId}.json`), receipt);
    });
    // Remove the owner before the directory; a crash between these operations
    // leaves an orphan lock that remains busy, never an automatic unlock.
    await fs.unlink(path.join(this.lockDirectory, "owner.json"));
    await fs.rmdir(this.lockDirectory);
  }
}
