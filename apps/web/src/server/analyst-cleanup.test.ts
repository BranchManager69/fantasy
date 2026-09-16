import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { AnalystBudget } from "./analyst-budget";
import { recoverPendingAnalystCleanup } from "./analyst-cleanup";

async function fixture(t: TestContext, sessionId: string | null = "sess_cleanup") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fantasy-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let instant = new Date("2026-09-16T05:00:00.000Z");
  const now = () => instant;
  const budget = new AnalystBudget({ directory, now });
  const runId = await budget.reserve();
  await budget.record(runId, { sessionId: sessionId ?? undefined, turnId: "turn_cleanup", status: "cleanup_pending", stage: "cleaning_up", errorCode: "none", usage: { input_tokens: 123 }, toolNames: ["prefetched_matchup"] });
  return { directory, budget, runId, now,
    advance: (ms = 5_000) => { instant = new Date(instant.getTime() + ms); },
    receipt: async () => JSON.parse(await readFile(path.join(directory, "runs", `${runId}.json`), "utf8")),
    session: (status = "idle") => ({ id: "sess_cleanup", status, metadata: { run_id: runId, application: "fantasy-2026" } }),
  };
}

const apiError = (status: number) => new OpenAI.APIError(status, {}, "provider error", new Headers());

test("only aged cleanup_pending receipts are eligible, and orphan locks never unlock by age", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const client = { beta: { agents: { sessions: { retrieve: async () => { calls++; throw new Error("not expected"); } } } } } as unknown as OpenAI;
  assert.equal(await recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now }), false);
  f.advance(4_999);
  assert.equal(await recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now }), false);
  await f.budget.record(f.runId, { status: "running" });
  f.advance(60_000);
  assert.equal(await recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now }), false);
  assert.equal(calls, 0);
  assert.equal((await f.budget.status()).busy, true);

  const orphanDirectory = path.join(f.directory, "orphan");
  await mkdir(path.join(orphanDirectory, "active.lock"), { recursive: true });
  const orphan = new AnalystBudget({ directory: orphanDirectory, now: f.now });
  assert.equal(await orphan.activeReceipt(), null);
  assert.equal(await recoverPendingAnalystCleanup({ client, budget: orphan, now: f.now }), false);
  assert.equal((await orphan.status()).busy, true);
});

test("a restarted budget recovers a confirmed deletion and preserves usage and original outcome", async (t) => {
  const f = await fixture(t);
  f.advance();
  const budget = new AnalystBudget({ directory: f.directory, now: f.now });
  const requests: { name: string; options: { timeout: number; maxRetries: number; signal: AbortSignal } }[] = [];
  const client = { beta: { agents: { sessions: {
    retrieve: async (_id: string, options: typeof requests[number]["options"]) => { requests.push({ name: "retrieve", options }); return f.session(); },
    delete: async (_id: string, options: typeof requests[number]["options"]) => { requests.push({ name: "delete", options }); return { deleted: true }; },
  } } } } as unknown as OpenAI;
  assert.equal(await recoverPendingAnalystCleanup({ client, budget, now: f.now }), true);
  assert.deepEqual(requests.map((request) => request.name), ["retrieve", "delete"]);
  assert.ok(requests.every(({ options }) => options.timeout === 5_000 && options.maxRetries === 0 && options.signal instanceof AbortSignal));
  assert.deepEqual(await budget.status(), { remaining: 5, dailyLimit: 6, busy: false });
  assert.equal(await budget.activeReceipt(), null);
  const receipt = await f.receipt();
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.cleanupVerified, true);
  assert.equal(receipt.sessionId, "sess_cleanup");
  assert.equal(receipt.turnId, "turn_cleanup");
  assert.deepEqual(receipt.usage, { input_tokens: 123 });
  assert.deepEqual(receipt.toolNames, ["prefetched_matchup"]);
  assert.ok(receipt.finishedAt);
});

for (const missingAt of ["retrieve", "delete"] as const) {
  test(`404 on ${missingAt} is independent proof of cleanup`, async (t) => {
    const f = await fixture(t);
    await f.budget.record(f.runId, { errorCode: "timeout" });
    f.advance();
    let deletes = 0;
    const client = { beta: { agents: { sessions: {
      retrieve: async () => { if (missingAt === "retrieve") throw apiError(404); return f.session(); },
      delete: async () => { deletes++; throw apiError(404); },
    } } } } as unknown as OpenAI;
    assert.equal(await recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now }), true);
    assert.equal(deletes, missingAt === "delete" ? 1 : 0);
    assert.equal((await f.receipt()).status, "failed");
    assert.equal((await f.receipt()).errorCode, "timeout");
    assert.equal((await f.budget.status()).busy, false);
  });
}

test("active sessions are cancelled before deletion; a conflict stays locked and delays retries", async (t) => {
  const f = await fixture(t);
  f.advance();
  const calls: string[] = [];
  const client = { beta: { agents: { sessions: {
    retrieve: async () => { calls.push("retrieve"); return f.session("in_progress"); },
    events: { create: async (_id: string, body: { events: { type: string }[] }) => { calls.push(body.events[0].type); } },
    delete: async () => { calls.push("delete"); throw apiError(409); },
  } } } } as unknown as OpenAI;
  assert.equal(await recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now }), false);
  assert.deepEqual(calls, ["retrieve", "agent.session.input.cancel", "delete"]);
  const receipt = await f.receipt();
  assert.equal(receipt.status, "cleanup_pending");
  assert.equal(receipt.updatedAt, f.now().toISOString());
  assert.equal((await f.budget.status()).busy, true);
  assert.equal(await recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now }), false);
  assert.equal(calls.length, 3);
  f.advance(4_999);
  assert.equal(await recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now }), false);
  assert.equal(calls.length, 3);
});

test("concurrent recovery requests share one remote cleanup attempt", async (t) => {
  const f = await fixture(t);
  f.advance();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let retrieves = 0;
  let deletes = 0;
  const client = { beta: { agents: { sessions: {
    retrieve: async () => { retrieves++; await gate; return f.session(); },
    delete: async () => { deletes++; return { deleted: true }; },
  } } } } as unknown as OpenAI;
  const first = recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now });
  const second = recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now });
  assert.equal(first, second);
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(retrieves, 1);
  assert.equal(deletes, 1);
});

test("ambiguous creation recovers only its own exact metadata match within three requests", async (t) => {
  const f = await fixture(t, null);
  f.advance();
  const calls: string[] = [];
  const client = { beta: { agents: { sessions: {
    list: async () => { calls.push("list"); return { data: [
      { id: "sess_other", status: "in_progress", metadata: { run_id: f.runId, application: "another-application" } },
      f.session("requires_action"),
    ] }; },
    events: { create: async (id: string) => { calls.push(`cancel:${id}`); } },
    delete: async (id: string) => { calls.push(`delete:${id}`); return { deleted: true }; },
  } } } } as unknown as OpenAI;
  assert.equal(await recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now }), true);
  assert.deepEqual(calls, ["list", "cancel:sess_cleanup", "delete:sess_cleanup"]);
  assert.equal((await f.receipt()).sessionId, "sess_cleanup");
});

test("no reconciliation match and unconfirmed deletion keep the gate closed", async (t) => {
  const f = await fixture(t);
  f.advance();
  const client = { beta: { agents: { sessions: {
    retrieve: async () => f.session(),
    delete: async () => ({ deleted: false }),
  } } } } as unknown as OpenAI;
  assert.equal(await recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now }), false);
  assert.equal((await f.budget.status()).busy, true);
  const receipt = await f.receipt();
  delete receipt.sessionId;
  await writeFile(path.join(f.directory, "runs", `${f.runId}.json`), JSON.stringify(receipt));
  f.advance();
  const unmatched = { beta: { agents: { sessions: { list: async () => ({ data: [] }) } } } } as unknown as OpenAI;
  assert.equal(await recoverPendingAnalystCleanup({ client: unmatched, budget: f.budget, now: f.now }), false);
  assert.equal((await f.budget.status()).busy, true);
  assert.equal((await f.receipt()).finishedAt, undefined);
});

test("activeReceipt rejects a changed run identity without unlocking", async (t) => {
  const f = await fixture(t);
  const receipt = await f.receipt();
  receipt.runId = "00000000-0000-0000-0000-000000000000";
  await writeFile(path.join(f.directory, "runs", `${f.runId}.json`), JSON.stringify(receipt));
  await assert.rejects(f.budget.activeReceipt(), /Invalid active analyst receipt/);
  assert.equal((await f.budget.status()).busy, true);
});

test("a transient local release failure can be recovered on the next eligible check", async (t) => {
  const f = await fixture(t);
  f.advance();
  const finish = f.budget.finish.bind(f.budget);
  let failures = 1;
  t.mock.method(f.budget, "finish", async (...args: Parameters<typeof f.budget.finish>) => {
    if (failures-- > 0) throw new Error("Transient disk failure");
    return finish(...args);
  });
  const client = { beta: { agents: { sessions: { retrieve: async () => { throw apiError(404); } } } } } as unknown as OpenAI;
  await assert.rejects(recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now }), /Transient disk failure/);
  assert.equal((await f.budget.activeReceipt())?.status, "cleanup_pending");
  assert.equal((await f.budget.status()).busy, true);
  f.advance();
  assert.equal(await recoverPendingAnalystCleanup({ client, budget: f.budget, now: f.now }), true);
  assert.equal((await f.budget.status()).busy, false);
});

test("availability GET recovers a pending session using only mocked cleanup requests", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fantasy-availability-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldDataRoot = process.env.DATA_ROOT;
  const oldKey = process.env.OPENAI_API_KEY;
  const tenantRoots = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("FANTASY_DATA_ROOT__")));
  for (const key of Object.keys(tenantRoots)) delete process.env[key];
  process.env.DATA_ROOT = directory;
  process.env.OPENAI_API_KEY = "test-placeholder-not-a-real-key";
  t.after(() => {
    if (oldDataRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = oldDataRoot;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    Object.assign(process.env, tenantRoots);
  });
  const budget = new AnalystBudget({ directory: path.join(directory, "history", "analyst"), now: () => new Date(Date.now() - 10_000) });
  const runId = await budget.reserve();
  await budget.record(runId, { sessionId: "sess_availability", status: "cleanup_pending", errorCode: "none" });
  const operations: string[] = [];
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Live requests are forbidden in this test"); });
  t.mock.method(OpenAI.prototype, "get", async (url: string) => {
    assert.equal(url, "/agents/sessions/sess_availability");
    operations.push("retrieve");
    return { id: "sess_availability", status: "idle", metadata: { run_id: runId, application: "fantasy-2026" } };
  });
  t.mock.method(OpenAI.prototype, "delete", async (url: string) => {
    assert.equal(url, "/agents/sessions/sess_availability");
    operations.push("delete");
    return { deleted: true };
  });
  const { GET } = await import("../app/api/analyst/route");
  const response = await GET();
  const availability = await response.json();
  assert.deepEqual(operations, ["retrieve", "delete"]);
  assert.equal(availability.enabled, true);
  assert.equal(availability.busy, false);
  assert.equal(availability.activity, null);
  assert.equal(availability.remaining, 5);
  assert.equal(JSON.stringify(availability).includes("sess_availability"), false);
});
