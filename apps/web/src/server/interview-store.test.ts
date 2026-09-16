import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { InterviewStore, InterviewStoreError, type InterviewRunFields } from "./interview-store";

async function directoryFor(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fantasy-interview-store-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const scope = { season: 2026, week: 1, teamId: 8 };
const hasCode = (code: string) => (error: unknown) => error instanceof InterviewStoreError && error.code === code;
const callSid = "CA" + "a".repeat(32);

test("concurrent reservations across instances permit one active interview", async (t) => {
  const root = await directoryFor(t);
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
    new InterviewStore(root).reserve({ ...scope, requestId: `request-${index}` })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of results) if (result.status === "rejected") assert.ok(hasCode("busy")(result.reason));
  const runs = await new InterviewStore(root).list();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "preparing");
  assert.equal(runs[0].dialAttemptedAt, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "ledger.json"), "utf8")).attempts, {});
});

test("request dedupe is durable and never reserves or dials again", async (t) => {
  const root = await directoryFor(t);
  const store = new InterviewStore(root);
  const input = { ...scope, requestId: "same-request" };
  const results = await Promise.all([store.reserve(input), new InterviewStore(root).reserve(input)]);
  assert.deepEqual(results.map((result) => result.existing), [false, true]);
  assert.equal(results[0].run.id, results[1].run.id);
  await store.update(results[0].run.id, { status: "dialing" });
  await store.update(results[0].run.id, { status: "completed", callSid });
  const recovered = await new InterviewStore(root).reserve(input);
  assert.equal(recovered.existing, true);
  assert.equal(recovered.run.status, "completed");
  assert.equal((await store.list()).length, 1);
  await assert.rejects(store.reserve({ ...input, teamId: 3 }), hasCode("conflict"));
});

test("failed preparation releases reservation without using a daily call attempt", async (t) => {
  const root = await directoryFor(t);
  const store = new InterviewStore(root, { dailyLimit: 1 });
  for (let index = 0; index < 4; index += 1) {
    const { run } = await store.reserve({ ...scope, requestId: `preflight-${index}` });
    await store.update(run.id, { status: "failed", failure: { code: "preflight", message: "Provider preflight rejected." } });
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "ledger.json"), "utf8")).attempts, {});
  const { run } = await store.reserve({ ...scope, requestId: "actual-attempt" });
  await store.update(run.id, { status: "ready" });
  await store.update(run.id, { status: "dialing" });
  await store.update(run.id, { status: "failed" });
  await assert.rejects(new InterviewStore(root, { dailyLimit: 1 }).reserve({ ...scope, requestId: "blocked" }), hasCode("daily_limit"));
  await assert.rejects(fs.stat(path.join(root, "active.lock")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("three first dial transitions exhaust the default cap despite errors or restarts", async (t) => {
  const root = await directoryFor(t);
  for (let index = 0; index < 3; index += 1) {
    const store = new InterviewStore(root);
    const { run } = await store.reserve({ ...scope, requestId: `attempt-${index}` });
    const first = await store.update(run.id, { status: "dialing" });
    const repeated = await store.update(run.id, { status: "dialing" });
    assert.equal(repeated.dialAttemptedAt, first.dialAttemptedAt);
    await store.update(run.id, { status: "failed" });
  }
  const attempts = JSON.parse(await fs.readFile(path.join(root, "ledger.json"), "utf8")).attempts;
  assert.equal(Object.keys(attempts).length, 3);
  await assert.rejects(new InterviewStore(root).reserve({ ...scope, requestId: "fourth" }), hasCode("daily_limit"));
});

test("day reset permits new attempts but cannot release an uncertain remote call", async (t) => {
  const root = await directoryFor(t);
  let instant = new Date("2026-09-16T23:59:59Z");
  const options = { dailyLimit: 1, now: () => instant };
  const store = new InterviewStore(root, options);
  const input = { ...scope, requestId: "uncertain" };
  const { run } = await store.reserve(input);
  await store.update(run.id, { status: "dialing" });
  await store.update(run.id, { status: "unknown", failure: { code: "network", message: "Call creation outcome is unknown." } });
  instant = new Date("2026-09-17T01:00:00Z");
  const restarted = new InterviewStore(root, options);
  await assert.rejects(restarted.reserve({ ...scope, requestId: "next-day" }), hasCode("busy"));
  const duplicate = await restarted.reserve(input);
  assert.equal(duplicate.existing, true);
  assert.equal(duplicate.run.status, "unknown");
  assert.equal((await restarted.update(run.id, { status: "ready" })).status, "unknown");
  // A verified provider callback can reconcile the original run; it never redials.
  assert.equal((await restarted.update(run.id, { status: "in-progress", callSid })).status, "in-progress");
  await restarted.update(run.id, { status: "completed" });
  const next = await restarted.reserve({ ...scope, requestId: "next-day" });
  const dialed = await restarted.update(next.run.id, { status: "dialing" });
  assert.ok(dialed.dialAttemptedAt?.startsWith("2026-09-17"));
  const attempts = Object.values(JSON.parse(await fs.readFile(path.join(root, "ledger.json"), "utf8")).attempts);
  assert.deepEqual(attempts, ["2026-09-16T23:59:59.000Z", "2026-09-17T01:00:00.000Z"]);
});

test("a process crash while dialing remains blocked with no age-based retry", async (t) => {
  const root = await directoryFor(t);
  const store = new InterviewStore(root);
  const { run } = await store.reserve({ ...scope, requestId: "before-crash" });
  await store.update(run.id, { status: "dialing" });
  const restarted = new InterviewStore(root, { now: () => new Date("2035-01-01T00:00:00Z") });
  await assert.rejects(restarted.reserve({ ...scope, requestId: "after-crash" }), hasCode("busy"));
  assert.equal((await restarted.find(run.id))?.status, "dialing");
});

test("callback states advance monotonically and a terminal result is immutable", async (t) => {
  const root = await directoryFor(t);
  let instant = new Date("2026-09-16T12:00:00Z");
  const store = new InterviewStore(root, { now: () => instant });
  const { run } = await store.reserve({ ...scope, requestId: "callbacks" });
  await store.update(run.id, { status: "queued", callSid });
  await store.update(run.id, { status: "ringing" });
  assert.equal((await store.update(run.id, { status: "queued" })).status, "ringing");
  await store.update(run.id, { status: "in-progress" });
  assert.equal((await store.update(run.id, { status: "ringing" })).status, "in-progress");
  const completed = await store.update(run.id, { status: "completed", finalized: true });
  instant = new Date("2026-09-16T12:05:00Z");
  const late = await store.update(run.id, { status: "failed", finalized: false, finalUsage: { output_tokens: 123 } });
  assert.equal(late.status, "completed");
  assert.equal(late.finalized, true);
  assert.equal(late.finishedAt, completed.finishedAt);
  assert.deepEqual(late.finalUsage, { output_tokens: 123 });
  assert.equal((await store.update(run.id, { status: "queued" })).status, "completed");
  const next = await store.reserve({ ...scope, requestId: "next" });
  await store.update(run.id, { status: "completed" });
  await assert.rejects(store.reserve({ ...scope, requestId: "third" }), hasCode("busy"));
  assert.equal((await store.find(next.run.id))?.status, "preparing");
});

test("records and structured events keep private permissions and omit secrets and full phones", async (t) => {
  const root = await directoryFor(t);
  const store = new InterviewStore(root);
  const { run } = await store.reserve({ ...scope, requestId: "metadata" });
  const phone = "+15551234567";
  const key = "sk-example-private-key-value";
  const updated = await store.update(run.id, {
    model: "gpt-live-1", backendModel: "backend-test", voice: "cedar", sourceRevision: "abc123",
    callerLast4: "4567", recipientLast4: "9876", briefPath: "brief.json", transcriptPath: "transcript.jsonl",
    liveSessionId: "live_session_example", audioMs: 1234, finalUsage: { input_tokens: 22 },
    failure: { code: "example", message: `Could not call ${phone} using ${key}` },
    metadata: { provider: "twilio", authorization: "Bearer private", phoneNumber: phone, nested: { api_key: key, hint: phone } },
    apiKey: key, to: phone,
  } as InterviewRunFields);
  assert.equal(updated.callerLast4, "4567");
  assert.deepEqual(updated.finalUsage, { input_tokens: 22 });
  await Promise.all(Array.from({ length: 4 }, (_, index) => store.markEvent(run.id, {
    type: "transcript.final", index, text: `Call ${phone}`, apiKey: key, to: phone, input_tokens: 10,
  })));
  const recordPath = path.join(root, "runs", `${run.id}.json`);
  const eventPath = path.join(root, "events", `${run.id}.jsonl`);
  const saved = await fs.readFile(recordPath, "utf8") + await fs.readFile(eventPath, "utf8");
  assert.ok(!saved.includes(phone));
  assert.ok(!saved.includes(key));
  assert.ok(!saved.includes("Bearer private"));
  const events = (await fs.readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.index), [0, 1, 2, 3]);
  assert.equal(events[0].input_tokens, 10);
  assert.equal(events[0].runId, run.id);
  for (const directory of [root, path.join(root, "runs"), path.join(root, "events"), path.join(root, "active.lock")]) {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  }
  for (const file of [recordPath, eventPath, path.join(root, "ledger.json"), path.join(root, "requests", "metadata.json")]) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
});

test("IDs and call identity are validated without allowing path traversal or replacement", async (t) => {
  const root = await directoryFor(t);
  const store = new InterviewStore(root);
  for (const requestId of ["../outside", "with/slash", "", "x".repeat(81)]) {
    await assert.rejects(store.reserve({ ...scope, requestId }), hasCode("invalid_request"));
  }
  await assert.rejects(store.find("../outside"), hasCode("invalid_request"));
  const { run } = await store.reserve({ ...scope, requestId: "valid" });
  await store.update(run.id, { callSid });
  await assert.rejects(store.update(run.id, { callSid: "CA" + "b".repeat(32) }), hasCode("conflict"));
  await assert.rejects(store.update(run.id, { recipientLast4: "+15551234567" }), hasCode("invalid_request"));
  await assert.rejects(store.update(run.id, { status: "anything" } as unknown as InterviewRunFields), hasCode("invalid_request"));
});

test("an orphaned reservation and a corrupt ledger fail closed across restarts", async (t) => {
  const orphanRoot = await directoryFor(t);
  await fs.mkdir(path.join(orphanRoot, "active.lock"));
  await assert.rejects(new InterviewStore(orphanRoot).reserve({ ...scope, requestId: "orphan" }), hasCode("busy"));
  const root = await directoryFor(t);
  const store = new InterviewStore(root);
  const { run } = await store.reserve({ ...scope, requestId: "first" });
  await store.update(run.id, { status: "dialing" });
  await store.update(run.id, { status: "completed" });
  await fs.writeFile(path.join(root, "ledger.json"), "{not-json}");
  await assert.rejects(new InterviewStore(root).reserve({ ...scope, requestId: "second" }), hasCode("unavailable"));
  // Inspection, not elapsed time, is required to resolve a broken durable ledger.
  await assert.rejects(new InterviewStore(root).reserve({ ...scope, requestId: "third" }), hasCode("busy"));
});

test("a lost ledger does not restore already spent allowance", async (t) => {
  const root = await directoryFor(t);
  const store = new InterviewStore(root);
  const { run } = await store.reserve({ ...scope, requestId: "first" });
  await store.update(run.id, { status: "dialing" });
  await store.update(run.id, { status: "completed" });
  await fs.unlink(path.join(root, "ledger.json"));
  await assert.rejects(new InterviewStore(root).reserve({ ...scope, requestId: "second" }), hasCode("unavailable"));
});

test("attempt timestamp survives a crash between ledger write and run update", async (t) => {
  const root = await directoryFor(t);
  const store = new InterviewStore(root, { dailyLimit: 1 });
  const { run } = await store.reserve({ ...scope, requestId: "interrupted-write" });
  const chargedAt = "2026-09-16T12:34:56.000Z";
  await fs.writeFile(path.join(root, "ledger.json"), JSON.stringify({ version: 1, attempts: { [run.id]: chargedAt } }));
  const recovered = await new InterviewStore(root, { dailyLimit: 1 }).update(run.id, { status: "dialing" });
  assert.equal(recovered.dialAttemptedAt, chargedAt);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(root, "ledger.json"), "utf8")).attempts).length, 1);
});

test("a run cannot start dialing if its durable reservation has disappeared", async (t) => {
  const root = await directoryFor(t);
  const store = new InterviewStore(root);
  const { run } = await store.reserve({ ...scope, requestId: "missing-lock" });
  await fs.rm(path.join(root, "active.lock"), { recursive: true });
  await assert.rejects(store.update(run.id, { status: "dialing" }), hasCode("unavailable"));
  assert.equal((await store.find(run.id))?.status, "preparing");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "ledger.json"), "utf8")).attempts, {});
});

test("list returns newest saved runs with the requested bound", async (t) => {
  const root = await directoryFor(t);
  let instant = new Date("2026-09-16T12:00:00Z");
  const store = new InterviewStore(root, { now: () => instant });
  assert.deepEqual(await store.list(), []);
  for (let index = 0; index < 3; index += 1) {
    const { run } = await store.reserve({ ...scope, requestId: `request-${index}` });
    await store.update(run.id, { status: "failed" });
    instant = new Date(instant.getTime() + 1000);
  }
  assert.deepEqual((await store.list(2)).map((run) => run.requestId), ["request-2", "request-1"]);
  await assert.rejects(store.list(0), hasCode("invalid_request"));
});
