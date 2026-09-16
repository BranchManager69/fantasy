import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnalystBudget, AnalystBudgetError, type AnalystRunFields } from "./analyst-budget";

async function directoryFor(t: { after: (callback: () => Promise<void>) => void }): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fantasy-analyst-budget-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AnalystBudgetError && error.code === code;
}

test("concurrent instances allow exactly one charged reservation", async (t) => {
  const directory = await directoryFor(t);
  const budgets = Array.from({ length: 12 }, () => new AnalystBudget({ directory, dailyLimit: 6 }));
  const reservations = await Promise.allSettled(budgets.map((budget) => budget.reserve()));
  const accepted = reservations.filter((result) => result.status === "fulfilled");
  assert.equal(accepted.length, 1);
  for (const rejected of reservations.filter((result) => result.status === "rejected")) {
    assert.ok(hasCode("busy")(rejected.reason));
  }
  const runId = accepted[0].value;
  assert.deepEqual(await budgets[0].status(), { remaining: 5, dailyLimit: 6, busy: true });
  // A separate instance can complete the persisted reservation after a restart.
  await new AnalystBudget({ directory }).finish(runId, { noRemoteSessionCreated: true });
  assert.equal((await budgets[0].status()).remaining, 5);
});

test("failed attempts remain charged across instances and exhausted reservations unlock", async (t) => {
  const directory = await directoryFor(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const budget = new AnalystBudget({ directory, dailyLimit: 2 });
    const runId = await budget.reserve();
    await budget.record(runId, { status: "creation_rejected" });
    await budget.finish(runId, { noRemoteSessionCreated: true });
  }
  const restarted = new AnalystBudget({ directory, dailyLimit: 2 });
  assert.deepEqual(await restarted.status(), { remaining: 0, dailyLimit: 2, busy: false });
  await assert.rejects(restarted.reserve(), hasCode("daily_limit"));
  assert.equal((await restarted.status()).busy, false);
  assert.equal((await fs.readdir(path.join(directory, "runs"))).length, 2);
});

test("UTC day reset refreshes allowance but never clears an active remote session", async (t) => {
  const directory = await directoryFor(t);
  let instant = new Date("2026-09-16T23:59:59.000Z");
  const budget = new AnalystBudget({ directory, dailyLimit: 1, now: () => instant });
  const runId = await budget.reserve();
  await budget.record(runId, { sessionId: "session_day_one", status: "running" });
  instant = new Date("2026-09-17T00:00:00.000Z");
  assert.deepEqual(await budget.status(), { remaining: 1, dailyLimit: 1, busy: true });
  await assert.rejects(budget.reserve(), hasCode("busy"));
  await budget.finish(runId, { cleanupVerified: true });
  const nextRun = await budget.reserve();
  assert.equal((await budget.status()).remaining, 0);
  const ledger = JSON.parse(await fs.readFile(path.join(directory, "ledger.json"), "utf8"));
  assert.deepEqual(ledger.days, { "2026-09-16": 1, "2026-09-17": 1 });
  await budget.finish(nextRun, { noRemoteSessionCreated: true });
});

test("cleanup failure and a false no-session claim preserve the active lock", async (t) => {
  const directory = await directoryFor(t);
  const budget = new AnalystBudget({ directory, dailyLimit: 6 });
  const runId = await budget.reserve();
  await budget.record(runId, { sessionId: "session_charged", turnId: "turn_1", status: "cleanup_failed" });
  await assert.rejects(budget.finish(runId, { cleanupVerified: false }), hasCode("cleanup_required"));
  await assert.rejects(budget.finish(runId, { noRemoteSessionCreated: true }), hasCode("cleanup_required"));
  const restarted = new AnalystBudget({ directory, dailyLimit: 6 });
  assert.equal((await restarted.status()).busy, true);
  await assert.rejects(restarted.reserve(), hasCode("busy"));
  await restarted.record(runId, { cleanupVerified: true });
  await restarted.finish(runId, {});
  assert.equal((await restarted.status()).busy, false);
  assert.equal((await restarted.status()).remaining, 5);
});

test("receipt persistence whitelists metadata and rejects content in usage", async (t) => {
  const directory = await directoryFor(t);
  const budget = new AnalystBudget({ directory });
  const runId = await budget.reserve();
  await budget.record(runId, { usage: null });
  const initial = JSON.parse(await fs.readFile(path.join(directory, "runs", `${runId}.json`), "utf8"));
  assert.equal(initial.usage, null);
  await budget.record(runId, {
    sessionId: "session_metadata", turnId: "turn_metadata", status: "completed",
    toolNames: ["league_report", "league_report"],
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } },
    prompt: "PRIVATE_PROMPT", apiKey: "PRIVATE_KEY", content: "PRIVATE_ANSWER",
  } as AnalystRunFields);
  const file = path.join(directory, "runs", `${runId}.json`);
  const text = await fs.readFile(file, "utf8");
  assert.ok(!text.includes("PRIVATE_"));
  const receipt = JSON.parse(text);
  assert.deepEqual(receipt.toolNames, ["league_report"]);
  assert.equal(receipt.usage.input_tokens_details.cached_tokens, 40);
  await assert.rejects(budget.record(runId, { usage: { content: "PRIVATE_ANSWER" } }), hasCode("invalid_receipt"));
  await budget.finish(runId, { cleanupVerified: true });
  assert.ok(JSON.parse(await fs.readFile(file, "utf8")).finishedAt);
});

test("an orphaned active lock stays blocked without any age-based recovery", async (t) => {
  const directory = await directoryFor(t);
  await fs.mkdir(path.join(directory, "active.lock"));
  const budget = new AnalystBudget({ directory, now: () => new Date("2030-01-01T00:00:00Z") });
  assert.equal((await budget.status()).busy, true);
  await assert.rejects(budget.reserve(), hasCode("busy"));
});

test("corrupt or lost ledger never resets already charged usage", async (t) => {
  const directory = await directoryFor(t);
  const budget = new AnalystBudget({ directory });
  const runId = await budget.reserve();
  await budget.finish(runId, { noRemoteSessionCreated: true });
  await fs.writeFile(path.join(directory, "ledger.json"), "not-json");
  await assert.rejects(budget.status(), hasCode("unavailable"));
  await fs.unlink(path.join(directory, "ledger.json"));
  await assert.rejects(budget.status(), hasCode("unavailable"));
  await assert.rejects(budget.reserve(), hasCode("unavailable"));
});

test("limit defaults to six, caps at twenty, and rejects invalid configuration", async (t) => {
  const directory = await directoryFor(t);
  const oldLimit = process.env.FANTASY_ANALYST_DAILY_LIMIT;
  t.after(async () => {
    if (oldLimit === undefined) delete process.env.FANTASY_ANALYST_DAILY_LIMIT;
    else process.env.FANTASY_ANALYST_DAILY_LIMIT = oldLimit;
  });
  delete process.env.FANTASY_ANALYST_DAILY_LIMIT;
  assert.equal((await new AnalystBudget({ directory }).status()).dailyLimit, 6);
  process.env.FANTASY_ANALYST_DAILY_LIMIT = "99";
  assert.equal((await new AnalystBudget({ directory }).status()).dailyLimit, 20);
  assert.equal((await new AnalystBudget({ directory, dailyLimit: 2 }).status()).dailyLimit, 2);
  assert.equal((await new AnalystBudget({ directory, dailyLimit: 0 }).status()).remaining, 0);
  process.env.FANTASY_ANALYST_DAILY_LIMIT = "broken";
  assert.throws(() => new AnalystBudget({ directory }), hasCode("invalid_limit"));
});
