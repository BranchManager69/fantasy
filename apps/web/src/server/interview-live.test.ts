import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ClientEvent } from "openai/resources/live/live";
import { createLiveInterview, type InterviewLiveConnection, type LiveInterviewOptions, type LiveInterviewEvent } from "./interview-live";

class FakeConnection implements InterviewLiveConnection {
  sent: ClientEvent[] = [];
  open = false;
  terminated = 0;
  closed = 0;
  private openListener = () => {};
  private eventListener: (event: unknown) => void = () => {};
  private errorListener: (error: unknown) => void = () => {};
  private closeListener = () => {};
  onOpen(listener: () => void) { this.openListener = listener; }
  onEvent(listener: (event: unknown) => void) { this.eventListener = listener; }
  onError(listener: (error: unknown) => void) { this.errorListener = listener; }
  onClose(listener: () => void) { this.closeListener = listener; }
  isOpen() { return this.open; }
  send(event: ClientEvent) { this.sent.push(structuredClone(event)); }
  close() { this.closed++; this.open = false; this.closeListener(); }
  terminate() { this.terminated++; this.open = false; this.closeListener(); }
  connect() { this.open = true; this.openListener(); }
  event(event: unknown) { this.eventListener(event); }
  error(error: unknown) { this.errorListener(error); }
  disconnect() { this.open = false; this.closeListener(); }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(t: TestContext, call: LiveInterviewOptions["prepared"]["call"] = async () => ({ score: 112.3 })) {
  const transport = new FakeConnection();
  const events: LiveInterviewEvent[] = [], audio: string[] = [], finalized: boolean[] = [];
  let ready = 0, ending = 0;
  const prepared = {
    brief: {} as LiveInterviewOptions["prepared"]["brief"],
    voiceInstructions: "You are Claire, interviewing the selected fantasy team. Identify yourself as AI.",
    researcherInstructions: "Use the fixed league evidence. A synthetic fixture is not a real game.",
    initialEvidence: '{"fixture":true,"score":112.3}',
    tools: [{ type: "function" as const, name: "get_matchup", description: "Read a synthetic matchup.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }], call,
  };
  const controller = createLiveInterview({ apiKey: "sk-test-secret-not-a-real-key", prepared,
    connectionFactory: () => transport, onEvent: (event) => events.push(event), onAudio: (value) => audio.push(value),
    onReady: () => { ready++; }, onClosed: (value) => finalized.push(value), onEndRequested: () => { ending++; } });
  t.after(() => transport.event({ type: "session.closed", reason: "close_requested", session: { id: "live_fixture" }, usage: { seconds: 1 } }));
  const start = () => {
    transport.connect();
    transport.event({ type: "session.started", session: { id: "live_fixture", instructions: "private prompt" } });
  };
  const ack = () => {
    const greeting = transport.sent.find((event) => event.type === "session.instructions.append");
    assert.ok(greeting);
    transport.event({ type: "session.instructions.appended", client_event_id: greeting.event_id });
  };
  const response = (id: string, calls: { id: string; name?: string; args?: string }[] = [], delegation = "delegation_fixture") => {
    const nested = (event: unknown) => transport.event({ type: "response.event", delegation_id: delegation, event });
    nested({ type: "response.created", response: { id } });
    for (const call of calls) nested({ type: "response.output_item.done", item: { type: "function_call", status: "completed",
      call_id: call.id, name: call.name ?? "get_matchup", arguments: call.args ?? "{}" } });
    return { nested, complete: () => nested({ type: "response.completed", response: { id, output: [], usage: { input_tokens: 24, output_tokens: 9 } } }) };
  };
  return { controller, transport, events, audio, finalized, prepared, start, ack, response,
    ready: () => ready, ending: () => ending };
}

test("starts the installed Live protocol once, with PCMU and a separately configured Responses backend", async (t) => {
  const h = harness(t);
  h.controller.appendAudio("/w==");
  assert.equal(h.transport.sent.length, 0);
  h.start(); h.transport.connect();
  const starts = h.transport.sent.filter((event) => event.type === "session.start");
  assert.equal(starts.length, 1);
  const config = starts[0].session;
  assert.equal(config.model, "gpt-live-1");
  assert.deepEqual(config.audio, { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: "marin" } });
  assert.equal(config.store, false);
  assert.equal(config.delegation?.type, "responses");
  if (config.delegation?.type !== "responses") return;
  assert.equal(config.delegation.responses.model, "gpt-6-astra");
  assert.equal(config.delegation.responses.max_output_tokens, 900);
  assert.equal(config.delegation.responses.parallel_tool_calls, false);
  assert.ok(config.delegation.responses.tools?.some((tool) => tool.type === "web_search"));
  assert.deepEqual(config.delegation.responses.reasoning, { effort: "low" });
  assert.ok(config.delegation.responses.instructions?.includes(h.prepared.initialEvidence));
  assert.ok(config.delegation.responses.instructions?.includes(h.prepared.voiceInstructions));
  assert.equal(h.ready(), 1);
  const greeting = h.transport.sent.find((event) => event.type === "session.instructions.append");
  assert.ok(greeting?.content.includes("AI and recording disclosure"));
  assert.ok(greeting?.content.includes("Wait for assent before the first substantive interview question"));
  h.controller.appendAudio("/w=="); // Audio is not blocked waiting for the context acknowledgment.
  h.transport.event({ type: "session.output_audio.delta", delta: "AQID" });
  assert.deepEqual(h.audio, ["AQID"]);
  assert.ok(h.transport.sent.some((event) => event.type === "session.input_audio.append" && event.audio === "/w=="));
  h.ack();
  assert.equal(JSON.stringify(h.events).includes("AQID"), false);
  assert.equal(JSON.stringify(h.events).includes("private prompt"), false);
});

test("waits for a completed response and submits every function result before exactly one continuation", async (t) => {
  const called: string[] = [];
  const h = harness(t, async (name) => { called.push(name); return { score: 112.3 }; });
  h.start(); h.ack();
  const batch = h.response("resp_one", [{ id: "call_one" }, { id: "call_two" }]);
  await tick();
  assert.equal(called.length, 0);
  batch.complete(); await tick();
  assert.equal(called.length, 2);
  const results = h.transport.sent.filter((event) => event.type === "response.item.create" || event.type === "response.create");
  assert.deepEqual(results.map((event) => event.type), ["response.item.create", "response.item.create", "response.create"]);
  assert.ok(results.every((event) => !("delegation_id" in event)));
  batch.complete(); await tick();
  assert.equal(called.length, 2);
  assert.equal(h.transport.sent.filter((event) => event.type === "response.create").length, 1);
});

test("preserves initial audio in order, covers the startup deadline, and rejects more than seventeen seconds", (t) => {
  const h = harness(t);
  h.controller.appendAudio("AQID");
  h.controller.appendAudio("BAUG");
  h.start(); h.ack();
  const audio = h.transport.sent.filter((event) => event.type === "session.input_audio.append");
  assert.deepEqual(audio.map((event) => event.audio), ["AQID", "BAUG"]);
  assert.ok(h.transport.sent.findIndex((event) => event.type === "session.instructions.append")
    > h.transport.sent.findIndex((event) => event.type === "session.input_audio.append"));
  const k = harness(t);
  k.controller.appendAudio(Buffer.alloc(136_000, 255).toString("base64"));
  assert.deepEqual(k.finalized, []);
  k.controller.appendAudio("/w==");
  assert.deepEqual(k.finalized, [false]);
  assert.ok(k.events.some((event) => event.code === "startup_audio_overflow"));
  k.start();
  assert.equal(k.transport.sent.length, 0);
});

test("duplicate function items execute once and terminal empty output does not erase the call", async (t) => {
  let calls = 0;
  const h = harness(t, async () => { calls++; return { ok: true }; }); h.start(); h.ack();
  const batch = h.response("resp_duplicate", [{ id: "call_same" }, { id: "call_same" }]);
  batch.complete(); await tick();
  assert.equal(calls, 1);
  assert.equal(h.transport.sent.filter((event) => event.type === "response.item.create").length, 1);
});

test("unsupported tools and nonempty arguments never reach prepared.call, and results are bounded", async (t) => {
  let calls = 0;
  const h = harness(t, async () => { calls++; return { secret: "sk-test-secret-not-a-real-key", oversized: "x".repeat(33 * 1024) }; });
  h.start(); h.ack();
  h.response("resp_guard", [{ id: "call_unknown", name: "read_any_file" }, { id: "call_path", args: '{"path":"/etc/passwd"}' }, { id: "call_large" }]).complete();
  await tick();
  assert.equal(calls, 1);
  const results = h.transport.sent.filter((event) => event.type === "response.item.create")
    .map((event) => event.item.type === "function_call_output" ? JSON.parse(String(event.item.output)) : null);
  assert.deepEqual(results.map((result) => result.error), ["unknown_tool", "invalid_arguments", "result_too_large"]);
  assert.equal(JSON.stringify(h.events).includes("/etc/passwd"), false);
  assert.equal(JSON.stringify(h.events).includes("sk-test-secret"), false);
});

test("audio continues during slow tools and interruption transcripts do not clear or cancel speech", async (t) => {
  let resolve!: (value: unknown) => void;
  const h = harness(t, () => new Promise((done) => { resolve = done; }));
  h.start(); h.ack(); h.response("resp_slow", [{ id: "call_slow" }]).complete(); await tick();
  h.controller.appendAudio("AQID");
  h.transport.event({ type: "session.input_transcript.delta", delta: " Wait, ", start_ms: 100, end_ms: 400 });
  h.transport.event({ type: "session.output_audio.delta", delta: "/w==" });
  assert.deepEqual(h.audio, ["/w=="]);
  assert.ok(h.events.some((event) => event.delta === " Wait, "));
  assert.equal(h.transport.sent.some((event) => /cancel|clear|commit/.test(event.type)), false);
  resolve({ ok: true }); await tick();
});

test("finish requests drain scheduling once, without claiming the goodbye was heard or closing audio", async (t) => {
  const h = harness(t); h.start(); h.ack();
  h.response("resp_finish", [{ id: "call_finish", name: "finish_interview" }]).complete(); await tick();
  assert.equal(h.ending(), 1);
  assert.deepEqual(h.finalized, []);
  h.transport.event({ type: "session.output_audio.delta", delta: "/w==" });
  assert.deepEqual(h.audio, ["/w=="]);
  h.response("resp_finish_again", [{ id: "call_finish_again", name: "finish_interview" }]).complete(); await tick();
  assert.equal(h.ending(), 1);
});

test("caps backend responses at six and custom calls at eight", async (t) => {
  const h = harness(t); h.start(); h.ack();
  for (let i = 1; i <= 6; i++) h.response(`resp_${i}`).complete();
  assert.deepEqual(h.finalized, []);
  h.response("resp_seven");
  assert.deepEqual(h.finalized, [false]);
  assert.ok(h.events.some((event) => event.code === "backend_response_limit"));

  let calls = 0;
  const k = harness(t, async () => { calls++; return {}; }); k.start(); k.ack();
  k.response("resp_many", Array.from({ length: 8 }, (_, i) => ({ id: `call_${i}` }))).complete(); await tick();
  assert.equal(calls, 8);
  k.response("resp_ninth", [{ id: "call_ninth" }]).complete(); await tick();
  assert.equal(calls, 8);
  assert.deepEqual(k.finalized, [false]);
});

test("counts hosted searches once per item, without logging query text, and bounds searches within a response", (t) => {
  const h = harness(t); h.start(); h.ack();
  const response = h.response("resp_search");
  for (let i = 1; i <= 6; i++) {
    response.nested({ type: "response.output_item.added", item: { type: "web_search_call", id: `search_${i}`, status: "in_progress" } });
    response.nested({ type: "response.web_search_call.in_progress", item_id: `search_${i}` });
    response.nested({ type: "response.output_item.done", item: { type: "web_search_call", id: `search_${i}`, status: "completed", action: { query: "private search text" } } });
    response.nested({ type: "response.web_search_call.completed", item_id: `search_${i}` });
  }
  assert.equal(h.events.filter((event) => event.type === "interview.web_search.started").length, 6);
  assert.equal(h.events.filter((event) => event.type === "interview.web_search.completed").length, 6);
  assert.equal(JSON.stringify(h.events).includes("private search text"), false);
  assert.deepEqual(h.finalized, []);
  response.nested({ type: "response.web_search_call.in_progress", item_id: "search_seven" });
  assert.deepEqual(h.finalized, [false]);
  assert.ok(h.events.some((event) => event.code === "web_search_limit"));
});

test("graceful close waits for session.closed, preserves final numeric usage, and calls onClosed once", async (t) => {
  const h = harness(t); h.start(); h.ack();
  let resolved = false;
  const closing = h.controller.close("caller_hangup").then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, false);
  assert.equal(h.transport.sent.filter((event) => event.type === "session.close").length, 1);
  h.controller.appendAudio("AQID");
  assert.equal(h.transport.sent.at(-1)?.type, "session.close");
  h.transport.event({ type: "session.closed", reason: "close_requested", session: { id: "live_fixture", instructions: "private" },
    usage: { seconds: 42, malicious: "secret", details: { tokens: 4 } } });
  await closing;
  assert.deepEqual(h.finalized, [true]);
  assert.deepEqual(h.events.find((event) => event.type === "session.closed")?.usage, { seconds: 42, details: { tokens: 4 } });
  h.transport.error(new Error("late error"));
  await h.controller.close("again");
  assert.deepEqual(h.finalized, [true]);
});

test("startup, greeting acknowledgment and finalization have bounded deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t);
  h.transport.connect();
  t.mock.timers.tick(15_000);
  assert.deepEqual(h.finalized, [false]);
  assert.ok(h.events.some((event) => event.code === "startup_timeout"));

  const greeting = harness(t); greeting.start();
  greeting.transport.event({ type: "session.instructions.appended", client_event_id: "wrong_ack" });
  t.mock.timers.tick(15_000);
  assert.deepEqual(greeting.finalized, [false]);
  assert.ok(greeting.events.some((event) => event.code === "greeting_ack_timeout"));

  const k = harness(t); k.start(); k.ack();
  const closing = k.controller.close("caller_hangup");
  t.mock.timers.tick(10_000);
  await closing;
  assert.deepEqual(k.finalized, [false]);
  assert.ok(k.events.some((event) => event.code === "finalization_timeout"));
});

test("provider errors expose safe codes only and terminate once; unexpected disconnect is not finalized", (t) => {
  const h = harness(t); h.start();
  h.transport.event({ type: "error", error: { code: "credit_balance_exhausted", message: "sk-test-secret-not-a-real-key", details: { prompt: "private" } } });
  h.transport.error(new Error("Authorization: sk-test-secret-not-a-real-key"));
  assert.deepEqual(h.finalized, [false]);
  assert.equal(h.transport.terminated, 1);
  assert.ok(h.events.some((event) => event.code === "credit_balance_exhausted"));
  assert.equal(JSON.stringify(h.events).includes("sk-test-secret"), false);
  assert.equal(JSON.stringify(h.events).includes("private"), false);
  const k = harness(t); k.start(); k.ack(); k.transport.disconnect();
  assert.deepEqual(k.finalized, [false]);
});
