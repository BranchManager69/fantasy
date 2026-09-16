import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { AnalystBudget } from "./analyst-budget";
import { AnalystRunError, runAnalyst } from "./analyst-runner";

const sessionId = "sess_test";
const turnId = "turn_test";
const created = { type: "agent.session.created", session: { id: sessionId } };
const turn = { type: "agent.session.turn.created", session_id: sessionId, turn_id: turnId, turn: { subagent_id: null } };
const action = { type: "agent.session.requires_action", session_id: sessionId, session: { required_actions: [{ type: "function_call", name: "get_matchup", arguments: {}, turn_id: turnId, call_id: "call_1" }] } };
const message = (phase: string, text: string) => ({ type: "agent.session.turn.item.done", session_id: sessionId, turn_id: turnId, item: { type: "message", role: "assistant", turn_id: turnId, phase, content: [{ type: "output_text", text }] } });
const completed = { type: "agent.session.turn.completed", session_id: sessionId, turn_id: turnId, usage: null, turn: { subagent_id: null, usage: null } };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fantasy-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, budget: new AnalystBudget({ directory, dailyLimit: 6 }) };
}

test("returns only the completed answer and handles a repeated pending function once", async (t) => {
  const { directory, budget } = await fixture(t);
  let functionCalls = 0;
  let submissions = 0;
  let deleted = false;
  const client = { beta: { agents: { sessions: {
    create: async () => Object.assign((async function* () { yield* [created, turn, action, action, message("commentary", "Checking..."), message("final_answer", "Walker flipped the matchup."), completed]; })(), { controller: new AbortController() }),
    events: { create: async () => { submissions++; } },
    items: { list: async () => ({ data: [] }) },
    turns: { retrieve: async () => ({ usage: null }) },
    delete: async () => { deleted = true; return { deleted: true }; },
  } } } } as unknown as OpenAI;
  const result = await runAnalyst({ client, budget, context: { tools: [], sources: [], call: async () => { functionCalls++; return { score: 112.3 }; } }, question: "What happened?", season: 2026, week: 1, teamId: 8 });
  assert.equal(result.answer, "Walker flipped the matchup.");
  assert.equal(functionCalls, 1); assert.equal(submissions, 1); assert.equal(deleted, true);
  assert.deepEqual(await budget.status(), { remaining: 5, dailyLimit: 6, busy: false });
  const receipt = JSON.parse(await readFile(path.join(directory, "runs", `${result.runId}.json`), "utf8"));
  assert.equal(receipt.usage, null); assert.equal(receipt.cleanupVerified, true);
});

test("a deadline sends server cancellation before deleting the hosted session", async (t) => {
  const { budget } = await fixture(t);
  const operations: string[] = [];
  const client = { beta: { agents: { sessions: {
    create: async (_body: unknown, options: { signal: AbortSignal }) => Object.assign((async function* () {
      yield created; yield turn;
      await new Promise((_, reject) => {
        if (options.signal.aborted) reject(new Error("aborted"));
        else options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    })(), { controller: new AbortController() }),
    events: { create: async (_id: string, body: { events: { type: string }[] }) => { operations.push(body.events[0].type); } },
    delete: async () => { operations.push("delete"); return { deleted: true }; },
  } } } } as unknown as OpenAI;
  await assert.rejects(runAnalyst({ client, budget, context: { tools: [], sources: [], call: async () => ({}) }, question: "Check", season: 2026, week: 1, teamId: 8, timeoutMs: 30 }), /time limit/);
  assert.deepEqual(operations, ["agent.session.input.cancel", "delete"]);
  assert.equal((await budget.status()).busy, false);
});

test("an ambiguous create failure holds the budget closed when no remote session can be identified", async (t) => {
  const { budget } = await fixture(t);
  const client = { beta: { agents: { sessions: {
    create: async () => { throw new Error("connection lost after request"); },
    list: async () => ({ data: [] }),
  } } } } as unknown as OpenAI;
  await assert.rejects(runAnalyst({ client, budget, context: { tools: [], sources: [], call: async () => ({}) }, question: "Check", season: 2026, week: 1, teamId: 8 }), (error) => error instanceof AnalystRunError && error.code === "cleanup_pending");
  assert.deepEqual(await budget.status(), { remaining: 5, dailyLimit: 6, busy: true });
});

test("the deadline also aborts fallback retrieval instead of returning a late answer", async (t) => {
  const { directory, budget } = await fixture(t);
  const operations: string[] = [];
  let fallbackReceivedSignal = false;
  const client = { beta: { agents: { sessions: {
    create: async () => Object.assign((async function* () {
      yield* [created, turn, action]; // The observer ends without a terminal event.
    })(), { controller: new AbortController() }),
    events: { create: async (_id: string, body: { events: { type: string }[] }) => {
      operations.push(body.events[0].type);
    } },
    turns: { retrieve: async (_id: string, _body: unknown, options?: { signal?: AbortSignal }) => {
      fallbackReceivedSignal = Boolean(options?.signal);
      if (options?.signal) {
        await new Promise((_, reject) => {
          const signal = options.signal!;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return { status: "completed", usage: null };
    } },
    items: { list: async () => ({ data: [message("final_answer", "A late answer.").item] }) },
    delete: async () => { operations.push("delete"); return { deleted: true }; },
  } } } } as unknown as OpenAI;

  await assert.rejects(runAnalyst({
    client, budget, context: { tools: [], sources: [], call: async () => ({ score: 112.3 }) },
    question: "Check", season: 2026, week: 1, teamId: 8, timeoutMs: 500,
  }), (error) => error instanceof AnalystRunError && error.code === "timeout");
  assert.equal(fallbackReceivedSignal, true);
  assert.deepEqual(operations, ["agent.session.input.tool_result", "agent.session.input.cancel", "delete"]);
  assert.deepEqual(await budget.status(), { remaining: 5, dailyLimit: 6, busy: false });
  const [receiptFile] = await readdir(path.join(directory, "runs"));
  const receipt = JSON.parse(await readFile(path.join(directory, "runs", receiptFile), "utf8"));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.cleanupVerified, true);
});

test("a completed answer survives cleanup failure while the budget remains locked", async (t) => {
  const { directory, budget } = await fixture(t);
  let deletionAttempted = false;
  const client = { beta: { agents: { sessions: {
    create: async () => Object.assign((async function* () {
      yield* [created, turn, action, message("final_answer", "A complete answer."), completed];
    })(), { controller: new AbortController() }),
    events: { create: async () => ({}) },
    items: { list: async () => ({ data: [message("final_answer", "A complete answer.").item] }) },
    turns: { retrieve: async () => ({ usage: null }) },
    delete: async () => { deletionAttempted = true; throw new Error("Cleanup connection failed"); },
  } } } } as unknown as OpenAI;

  const result = await runAnalyst({
    client, budget, context: { tools: [], sources: [], call: async () => ({ score: 112.3 }) },
    question: "Check", season: 2026, week: 1, teamId: 8,
  });
  assert.equal(result.answer, "A complete answer.");
  assert.equal(result.cleanupPending, true);
  assert.equal(deletionAttempted, true);
  assert.deepEqual(await budget.status(), { remaining: 5, dailyLimit: 6, busy: true });
  const [receiptFile] = await readdir(path.join(directory, "runs"));
  const receipt = JSON.parse(await readFile(path.join(directory, "runs", receiptFile), "utf8"));
  assert.equal(receipt.status, "cleanup_pending");
  assert.equal(receipt.cleanupVerified, false);
  assert.equal(receipt.finishedAt, undefined);
});

test("an SDK abort at the deadline is recorded as timeout, not an undefined provider code", async (t) => {
  const { directory, budget } = await fixture(t);
  const operations: string[] = [];
  const client = { beta: { agents: { sessions: {
    create: async (_body: unknown, options: { signal: AbortSignal }) => Object.assign((async function* () {
      yield created; yield turn;
      await new Promise((_, reject) => {
        const fail = () => reject(new OpenAI.APIUserAbortError());
        if (options.signal.aborted) fail();
        else options.signal.addEventListener("abort", fail, { once: true });
      });
    })(), { controller: new AbortController() }),
    events: { create: async (_id: string, body: { events: { type: string }[] }) => { operations.push(body.events[0].type); } },
    delete: async () => { operations.push("delete"); return { deleted: true }; },
  } } } } as unknown as OpenAI;

  await assert.rejects(runAnalyst({
    client, budget, context: { tools: [], sources: [], call: async () => ({}) },
    question: "Check", season: 2026, week: 1, teamId: 8, timeoutMs: 150,
  }), (error) => error instanceof AnalystRunError && error.code === "timeout");
  assert.deepEqual(operations, ["agent.session.input.cancel", "delete"]);
  const [receiptFile] = await readdir(path.join(directory, "runs"));
  const receipt = JSON.parse(await readFile(path.join(directory, "runs", receiptFile), "utf8"));
  assert.equal(receipt.errorCode, "timeout");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.cleanupVerified, true);
  assert.equal((await budget.status()).busy, false);
});

test("a later browser disconnect does not relabel the deadline that already ended the run", async (t) => {
  const { budget } = await fixture(t);
  const disconnect = new AbortController();
  const client = { beta: { agents: { sessions: {
    create: async (_body: unknown, options: { signal: AbortSignal }) => Object.assign((async function* () {
      yield created; yield turn;
      await new Promise((_, reject) => {
        const fail = () => { disconnect.abort(); reject(new OpenAI.APIUserAbortError()); };
        if (options.signal.aborted) fail();
        else options.signal.addEventListener("abort", fail, { once: true });
      });
    })(), { controller: new AbortController() }),
    events: { create: async () => ({}) },
    delete: async () => ({ deleted: true }),
  } } } } as unknown as OpenAI;
  await assert.rejects(runAnalyst({
    client, budget, context: { tools: [], sources: [], call: async () => ({}) },
    question: "Check", season: 2026, week: 1, teamId: 8, signal: disconnect.signal, timeoutMs: 150,
  }), (error) => error instanceof AnalystRunError && error.code === "timeout");
  assert.equal((await budget.status()).busy, false);
});

test("a silent SDK stream abort stops before attempting fallback retrieval", async (t) => {
  const { directory, budget } = await fixture(t);
  let fallbackReads = 0;
  const operations: string[] = [];
  const client = { beta: { agents: { sessions: {
    create: async (_body: unknown, options: { signal: AbortSignal }) => Object.assign((async function* () {
      yield created; yield turn;
      // The real SDK swallows native transport AbortError and ends its iterator.
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    })(), { controller: new AbortController() }),
    events: { create: async (_id: string, body: { events: { type: string }[] }) => { operations.push(body.events[0].type); } },
    turns: { retrieve: async () => { fallbackReads++; throw new OpenAI.APIUserAbortError(); } },
    delete: async () => { operations.push("delete"); return { deleted: true }; },
  } } } } as unknown as OpenAI;

  await assert.rejects(runAnalyst({
    client, budget, context: { tools: [], sources: [], call: async () => ({}) },
    question: "Check", season: 2026, week: 1, teamId: 8, timeoutMs: 150,
  }), (error) => error instanceof AnalystRunError && error.code === "timeout");
  assert.equal(fallbackReads, 0);
  assert.deepEqual(operations, ["agent.session.input.cancel", "delete"]);
  const [receiptFile] = await readdir(path.join(directory, "runs"));
  const receipt = JSON.parse(await readFile(path.join(directory, "runs", receiptFile), "utf8"));
  assert.equal(receipt.errorCode, "timeout");
  assert.equal(receipt.cleanupVerified, true);
});

test("client disconnection remains distinct from timeout and completed tool progress is durable", async (t) => {
  const { directory, budget } = await fixture(t);
  const disconnect = new AbortController();
  let progressBeforeDisconnect: { stage?: string; toolNames?: string[] } = {};
  const operations: string[] = [];
  const client = { beta: { agents: { sessions: {
    create: async () => Object.assign((async function* () {
      yield* [created, turn, action];
      const [receiptFile] = await readdir(path.join(directory, "runs"));
      progressBeforeDisconnect = JSON.parse(await readFile(path.join(directory, "runs", receiptFile), "utf8"));
      disconnect.abort();
      throw new OpenAI.APIUserAbortError();
    })(), { controller: new AbortController() }),
    events: { create: async (_id: string, body: { events: { type: string }[] }) => { operations.push(body.events[0].type); } },
    delete: async () => { operations.push("delete"); return { deleted: true }; },
  } } } } as unknown as OpenAI;

  await assert.rejects(runAnalyst({
    client, budget, context: { tools: [], sources: [], call: async () => ({ score: 112.3 }) },
    question: "Check", season: 2026, week: 1, teamId: 8, signal: disconnect.signal,
  }), (error) => error instanceof AnalystRunError && error.code === "disconnected");
  assert.ok(progressBeforeDisconnect.toolNames?.includes("get_matchup"), "finished evidence retrieval is durable before the run ends");
  assert.ok(["researching", "answering"].includes(progressBeforeDisconnect.stage ?? ""));
  assert.deepEqual(operations, ["agent.session.input.tool_result", "agent.session.input.cancel", "delete"]);
  const [receiptFile] = await readdir(path.join(directory, "runs"));
  const receipt = JSON.parse(await readFile(path.join(directory, "runs", receiptFile), "utf8"));
  assert.equal(receipt.errorCode, "disconnected");
  assert.equal(receipt.stage, "failed");
  assert.equal(receipt.cleanupVerified, true);
});

test("disconnect during creating progress never attempts a remote create or leaves cleanup pending", async (t) => {
  const { directory, budget } = await fixture(t);
  const disconnect = new AbortController();
  let creates = 0;
  let reconciliations = 0;
  const client = { beta: { agents: { sessions: {
    create: async () => { creates++; throw new OpenAI.APIUserAbortError(); },
    list: async () => { reconciliations++; return { data: [] }; },
  } } } } as unknown as OpenAI;

  await assert.rejects(runAnalyst({
    client, budget, context: { tools: [], sources: [], call: async () => ({}) },
    question: "Check", season: 2026, week: 1, teamId: 8, signal: disconnect.signal,
    onProgress: (progress) => { if (progress.stage === "creating") disconnect.abort(); },
  }), (error) => error instanceof AnalystRunError && error.code === "disconnected");
  assert.equal(creates, 0);
  assert.equal(reconciliations, 0);
  assert.equal((await budget.status()).busy, false);
  const [receiptFile] = await readdir(path.join(directory, "runs"));
  const receipt = JSON.parse(await readFile(path.join(directory, "runs", receiptFile), "utf8"));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.errorCode, "disconnected");
  assert.equal(receipt.noRemoteSessionCreated, true);
});

for (const failedRead of ["saved_items", "usage"] as const) {
  test(`a completed streamed answer survives a failed optional ${failedRead} read`, async (t) => {
    const { directory, budget } = await fixture(t);
    const operations: string[] = [];
    const answer = "The bench swap would have changed the final points comparison.";
    const client = { beta: { agents: { sessions: {
      create: async () => Object.assign((async function* () {
        yield* [created, turn, action, message("final_answer", answer), completed];
      })(), { controller: new AbortController() }),
      events: { create: async (_id: string, body: { events: { type: string }[] }) => { operations.push(body.events[0].type); } },
      items: { list: async () => {
        if (failedRead === "saved_items") throw new OpenAI.APIConnectionTimeoutError();
        return { data: [message("final_answer", answer).item] };
      } },
      turns: { retrieve: async () => { throw new OpenAI.APIUserAbortError(); } },
      delete: async () => { operations.push("delete"); return { deleted: true }; },
    } } } } as unknown as OpenAI;

    const result = await runAnalyst({
      client, budget, context: { tools: [], sources: [], call: async () => ({ score: 112.3 }) },
      question: "What if I changed my lineup?", season: 2026, week: 1, teamId: 8,
    });
    assert.equal(result.answer, answer);
    assert.deepEqual(operations, ["agent.session.input.tool_result", "delete"]);
    const receipt = JSON.parse(await readFile(path.join(directory, "runs", `${result.runId}.json`), "utf8"));
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.usage, null);
    assert.equal(receipt.cleanupVerified, true);
    assert.equal((await budget.status()).busy, false);
  });
}

test("prefetched matchup evidence is supplied on creation and needs no redundant function round trip", async (t) => {
  const { directory, budget } = await fixture(t);
  let submittedInput: unknown;
  let toolCalls = 0;
  let toolSubmissions = 0;
  const initialEvidence = JSON.stringify({ season: 2026, week: 1, team_id: 8, selected: { official_score: 112.3 }, opponent: { official_score: 109.5 } });
  const answer = "Your team won by 2.8 points.";
  const client = { beta: { agents: { sessions: {
    create: async (body: { input: unknown }) => {
      submittedInput = body.input;
      return Object.assign((async function* () {
        yield* [created, turn, message("final_answer", answer), completed];
      })(), { controller: new AbortController() });
    },
    events: { create: async () => { toolSubmissions++; } },
    items: { list: async () => ({ data: [message("final_answer", answer).item] }) },
    turns: { retrieve: async () => ({ usage: null }) },
    delete: async () => ({ deleted: true }),
  } } } } as unknown as OpenAI;
  const progress: { runId: string; stage: string; message: string; elapsedMs: number }[] = [];

  const result = await runAnalyst({
    client, budget, context: { tools: [], sources: [], initialEvidence, call: async () => { toolCalls++; return {}; } },
    question: "What was the margin?", season: 2026, week: 1, teamId: 8,
    onProgress: (event) => { progress.push(event); },
  });
  const inputText = typeof submittedInput === "string" ? submittedInput : JSON.stringify(submittedInput);
  assert.match(inputText, /What was the margin\?/);
  assert.ok(inputText.includes(initialEvidence) || inputText.includes(JSON.stringify(initialEvidence)), "initial input contains the supplied evidence");
  assert.equal(result.answer, answer);
  assert.equal(toolCalls, 0);
  assert.equal(toolSubmissions, 0);
  assert.ok(result.toolsUsed.includes("prefetched_matchup"));
  assert.ok(progress.some((event) => event.stage === "creating"));
  assert.ok(progress.some((event) => event.stage === "completed"));
  assert.ok(progress.every((event) => event.runId === result.runId && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0));
  const receipt = JSON.parse(await readFile(path.join(directory, "runs", `${result.runId}.json`), "utf8"));
  assert.equal(receipt.stage, "completed");
  assert.equal(receipt.cleanupVerified, true);
});

test("writer overrides and labelled evidence reuse the lifecycle with a larger bounded response", async (t) => {
  const { budget } = await fixture(t);
  const writer = { model: "test-studio-model", instructions: "Return the supplied studio evidence as a storyboard." };
  const answer = "a".repeat(20_000);
  let suppliedAgent: { model: string; instructions: string } | undefined;
  const client = { beta: { agents: { sessions: {
    create: async (body: { agent: typeof writer }) => {
      suppliedAgent = body.agent;
      return Object.assign((async function* () { yield* [created, turn, message("final_answer", answer), completed]; })(), { controller: new AbortController() });
    },
    turns: { retrieve: async () => ({ usage: null }) },
    delete: async () => ({ deleted: true }),
  } } } } as unknown as OpenAI;
  const result = await runAnalyst({
    client, budget, context: { tools: [], sources: [], initialEvidence: '{"people":[]}', evidenceLabel: "studio_context", call: async () => { throw new Error("No redundant evidence call expected"); } },
    question: "Make a storyboard", season: 2026, week: 1, teamId: 8, writer, maxOutputChars: 24_000,
  });
  assert.equal(suppliedAgent?.model, writer.model);
  assert.equal(suppliedAgent?.instructions, writer.instructions);
  assert.equal(result.answer.length, 20_000);
  assert.deepEqual(result.toolsUsed, ["studio_context"]);
  assert.equal(result.cleanupPending, false);
  assert.equal((await budget.status()).busy, false);
});

for (const limit of [{ configured: 10, length: 11 }, { configured: 50_000, length: 32_001 }]) {
  test(`output stays bounded with requested limit ${limit.configured}`, async (t) => {
    const { budget } = await fixture(t);
    let deleted = false;
    const client = { beta: { agents: { sessions: {
      create: async () => Object.assign((async function* () { yield* [created, turn, message("final_answer", "a".repeat(limit.length)), completed]; })(), { controller: new AbortController() }),
      delete: async () => { deleted = true; return { deleted: true }; },
    } } } } as unknown as OpenAI;
    await assert.rejects(runAnalyst({
      client, budget, context: { tools: [], sources: [], initialEvidence: "{}", call: async () => ({}) },
      question: "Check", season: 2026, week: 1, teamId: 8, maxOutputChars: limit.configured,
    }), (error) => error instanceof AnalystRunError && error.code === "output_limit");
    assert.equal(deleted, true);
    assert.equal((await budget.status()).busy, false);
  });
}

test("finished text survives optional progress and malformed usage without logging provider content", async (t) => {
  const { directory, budget } = await fixture(t);
  const record = budget.record.bind(budget);
  t.mock.method(budget, "record", async (...args: Parameters<typeof budget.record>) => {
    if (args[1].stage === "finalizing") throw new Error("Temporary receipt failure");
    return record(...args);
  });
  const logs: string[] = [];
  t.mock.method(console, "info", (value: string) => { logs.push(value); });
  const client = { beta: { agents: { sessions: {
    create: async () => Object.assign((async function* () { yield* [created, turn, action, message("final_answer", "A preserved answer."), { ...completed, usage: { input_tokens: "PRIVATE_UNTRUSTED_CONTENT" } }]; })(), { controller: new AbortController() }),
    events: { create: async () => ({}) },
    delete: async () => ({ deleted: true }),
  } } } } as unknown as OpenAI;
  const result = await runAnalyst({ client, budget, context: { tools: [], sources: [], call: async () => ({}) }, question: "Check", season: 2026, week: 1, teamId: 8 });
  assert.equal(result.answer, "A preserved answer.");
  assert.equal(result.cleanupPending, false);
  assert.equal((await budget.status()).busy, false);
  const receipt = await readFile(path.join(directory, "runs", `${result.runId}.json`), "utf8");
  assert.ok(!receipt.includes("PRIVATE_UNTRUSTED_CONTENT"));
  assert.ok(!logs.join("\n").includes("PRIVATE_UNTRUSTED_CONTENT"));
});

test("a local release failure preserves the finished answer and keeps cleanup eligible for retry", async (t) => {
  const { budget } = await fixture(t);
  t.mock.method(budget, "finish", async () => { throw new Error("Temporary local release failure"); });
  const client = { beta: { agents: { sessions: {
    create: async () => Object.assign((async function* () { yield* [created, turn, action, message("final_answer", "A preserved answer."), completed]; })(), { controller: new AbortController() }),
    events: { create: async () => ({}) },
    turns: { retrieve: async () => ({ usage: null }) },
    delete: async () => ({ deleted: true }),
  } } } } as unknown as OpenAI;
  const result = await runAnalyst({ client, budget, context: { tools: [], sources: [], call: async () => ({}) }, question: "Check", season: 2026, week: 1, teamId: 8 });
  assert.equal(result.answer, "A preserved answer.");
  assert.equal(result.cleanupPending, true);
  assert.equal((await budget.status()).busy, true);
  const receipt = await budget.activeReceipt();
  assert.equal(receipt?.status, "cleanup_pending");
  assert.equal(receipt?.cleanupVerified, true);
  assert.equal(receipt?.errorCode, "none");
});
