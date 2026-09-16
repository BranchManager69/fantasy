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
  await assert.rejects(runAnalyst({ client, budget, context: { tools: [], sources: [], call: async () => ({}) }, question: "Check", season: 2026, week: 1, teamId: 8 }), /cleanup could not be confirmed/);
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

test("an otherwise complete answer is not returned when session cleanup fails", async (t) => {
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

  await assert.rejects(runAnalyst({
    client, budget, context: { tools: [], sources: [], call: async () => ({ score: 112.3 }) },
    question: "Check", season: 2026, week: 1, teamId: 8,
  }), (error) => error instanceof AnalystRunError && error.code === "cleanup_pending");
  assert.equal(deletionAttempted, true);
  assert.deepEqual(await budget.status(), { remaining: 5, dailyLimit: 6, busy: true });
  const [receiptFile] = await readdir(path.join(directory, "runs"));
  const receipt = JSON.parse(await readFile(path.join(directory, "runs", receiptFile), "utf8"));
  assert.equal(receipt.status, "cleanup_pending");
  assert.equal(receipt.cleanupVerified, false);
  assert.equal(receipt.finishedAt, undefined);
});
