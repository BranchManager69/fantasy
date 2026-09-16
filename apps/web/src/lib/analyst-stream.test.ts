import assert from "node:assert/strict";
import { test } from "node:test";
import { readAnalystStream } from "./analyst-stream";

const encoder = new TextEncoder();
const answer = { answer: "A late touchdown changed the result.", sources: [], runId: "test-run" };
const event = (kind: string, value: unknown) => `event: ${kind}\ndata: ${JSON.stringify(value)}\n\n`;

test("reads fragmented UTF-8, CRLF boundaries, multiline data, and heartbeats", async () => {
  const bytes = encoder.encode(": heartbeat\r\n\r\nevent: progress\r\ndata: {\r\ndata: \"message\": \"Checking André’s lineup\"\r\ndata: }\r\n\r\n"
    + event("result", answer).replace(/\n/g, "\r\n"));
  let offset = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const progress: string[] = [];

  assert.deepEqual(await readAnalystStream(response, (message) => progress.push(message)), answer);
  assert.deepEqual(progress, ["Checking André’s lineup"]);
  assert.equal(cancelled, true);
});

test("returns a result without reading a later transport error or waiting for cancellation", async () => {
  let reads = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++reads === 1) controller.enqueue(encoder.encode(event("result", answer)));
      else controller.error(new Error("Connection reset after the answer"));
    },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  }, { highWaterMark: 0 }));

  assert.deepEqual(await readAnalystStream(response, () => {}), answer);
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
});

test("ignores events after a completed result in the same chunk", async () => {
  const response = new Response(event("result", answer) + event("error", { error: "Late error" }));
  assert.deepEqual(await readAnalystStream(response, () => {}), answer);
});

test("an error before a result is surfaced and cancels the unfinished stream", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(event("error", { error: "The analyst reached its time limit." }) + event("result", answer))); },
    cancel() { cancelled = true; },
  }));

  await assert.rejects(readAnalystStream(response, () => {}), /time limit/);
  assert.equal(cancelled, true);
});

test("a transport error before the result never becomes a successful answer", async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error("Connection reset before the answer")); },
  }));
  await assert.rejects(readAnalystStream(response, () => {}), /Connection reset before the answer/);
});

test("a malformed update is rejected and cancels the unfinished stream", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode("event: progress\ndata: {bad json}\n\n")); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readAnalystStream(response, () => {}), /unreadable update/);
  assert.equal(cancelled, true);
});

test("EOF without a complete result and an invalid result are rejected", async () => {
  await assert.rejects(readAnalystStream(new Response(event("progress", { message: "Working" })), () => {}), /before an answer arrived/);
  await assert.rejects(readAnalystStream(new Response(event("result", { answer: "", sources: [] })), () => {}), /answer could not be read/);
});
