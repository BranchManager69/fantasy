import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { LiveWS } from "openai/resources/live/ws";
import twilio from "twilio";
import { WebSocketServer, WebSocket } from "ws";
import { getDataRoot } from "../src/lib/paths";
import { prepareInterviewBrief } from "../src/server/interview-brief";
import { createLiveInterview } from "../src/server/interview-live";
import { InterviewStore } from "../src/server/interview-store";
import { answerXml, authorizedControl, phoneConfig, PlaybackReceipts, validTwilioRequest, validateMediaStart } from "../src/server/interview-phone";

const config = phoneConfig(process.env);
const root = path.join(getDataRoot(), "private", "interviews");
const store = new InterviewStore(root);
const provider = twilio(config.accountSid, config.authToken, { autoRetry: false, timeout: 15_000 });
const prepared = new Map<string, Awaited<ReturnType<typeof prepareInterviewBrief>>>();
const active = new Map<string, { stop(reason: string): Promise<void> }>();
const dialingIds = new Set<string>();
const terminal = new Set(["completed", "busy", "no-answer", "canceled", "failed"]);
const callbackStates = new Set(["queued", "ringing", "in-progress", ...terminal]);
let accepting = true;

function failure(error: unknown) {
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value?.code === "string" || typeof value?.code === "number" ? String(value.code) : "interview_error";
  // Provider errors can contain recipient numbers. Keep operational records redacted.
  const message = (typeof value?.message === "string" ? value.message : "Interview operation failed")
    .replace(/\+[1-9]\d{7,14}/g, "[phone]").replace(/sk-[A-Za-z0-9_-]+/g, "[key]").slice(0, 450);
  return { code, message };
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
const streamToken = (id: string, callSid: string) => createHmac("sha256", config.controlToken).update(`${id}:${callSid}`).digest("hex");

/** Check the selected voice model before asking Twilio to ring a phone. */
async function preflight() {
  return new Promise<{ model: string; finalized: boolean }>((resolve, reject) => {
    const live = new LiveWS(new OpenAI({ apiKey: config.apiKey, maxRetries: 0 }), { reconnect: null });
    let settled = false;
    const done = (error?: unknown, finalized = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer); live.close();
      if (error) reject(error); else resolve({ model: "gpt-live-1", finalized });
    };
    const timer = setTimeout(() => done(new Error("Voice connection check timed out")), 15_000);
    live.socket.on("open", () => live.send({ type: "session.start", session: {
      model: "gpt-live-1", instructions: "Connection check. Listen quietly.",
      audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: config.voice } },
      delegation: { type: "responses", responses: { model: config.backendModel, max_output_tokens: 900 } },
    } }));
    live.on("event", (event) => {
      if (event.type === "session.started") live.send({ type: "session.close" });
      if (event.type === "session.closed") done(undefined, true);
      if (event.type === "error") done(Object.assign(new Error(event.error.message), { code: event.error.code }));
    });
    live.on("error", (error) => done(error));
    live.socket.on("close", () => { if (!settled) done(new Error("Voice check closed without final usage")); });
  });
}

async function stopCall(id: string, reason: string) {
  const running = active.get(id);
  if (running) return running.stop(reason);
  const run = await store.find(id);
  if (!run || terminal.has(run.status)) return;
  if (run.callSid) {
    // Ending an already reserved self-test is the only provider mutation here.
    const call = await provider.calls(run.callSid).update({ status: "completed" });
    await store.update(id, { status: callbackStates.has(call.status) ? call.status as "completed" : "unknown" });
  } else if (["preparing", "ready"].includes(run.status)) {
    await store.update(id, { status: "canceled" });
  } else throw new Error("Dispatch outcome is uncertain; reconcile it before another call");
  prepared.delete(id);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (req.method === "GET" && pathname === "/interview/health") {
    return json(res, 200, { ok: accepting, service: "league-interview", model: "gpt-live-1", revision: process.env.FANTASY_INTERVIEW_REVISION || "uncommitted" });
  }
  if (pathname.startsWith("/internal/")) {
    if (!authorizedControl(req.headers.authorization, config.controlToken)) return json(res, 401, { error: "Unauthorized" });
    if (req.method === "GET" && pathname === "/internal/status") {
      return json(res, 200, { model: "gpt-live-1", backendModel: config.backendModel, voice: config.voice,
        callerLast4: config.from.slice(-4), recipientLast4: config.to.slice(-4), runs: await store.list(10) });
    }
    if (req.method !== "POST" || !accepting) return json(res, 405, { error: "Unavailable" });
    const input = JSON.parse(await body(req) || "{}");
    if (pathname === "/internal/preflight") return json(res, 200, await preflight());
    if (pathname === "/internal/prepare") {
      const selection = { season: input.season, week: input.week, teamId: input.teamId };
      if (!Number.isInteger(selection.season) || selection.season < 2020 || selection.season > 2100
          || !Number.isInteger(selection.week) || selection.week < 1 || selection.week > 18
          || !Number.isInteger(selection.teamId) || selection.teamId < 1) return json(res, 400, { error: "Invalid matchup selection" });
      const reservation = await store.reserve({ requestId: input.requestId, ...selection });
      if (reservation.existing) return json(res, 200, { existing: true, run: reservation.run });
      const id = reservation.run.id;
      try {
        const packet = await prepareInterviewBrief(selection);
        await fs.mkdir(path.join(root, id), { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(root, id, "brief.json"), JSON.stringify(packet.brief, null, 2), { mode: 0o600 });
        prepared.set(id, packet);
        const run = await store.update(id, { status: "ready", model: "gpt-live-1", voice: config.voice,
          backendModel: config.backendModel, sourceRevision: process.env.FANTASY_INTERVIEW_REVISION || "uncommitted",
          callerLast4: config.from.slice(-4), recipientLast4: config.to.slice(-4), briefPath: path.join(root, id, "brief.json") });
        return json(res, 200, { run, brief: packet.brief });
      } catch (error) {
        await store.update(id, { status: "failed", failure: failure(error) });
        prepared.delete(id); throw error;
      }
    }
    if (pathname === "/internal/dial") {
      if (typeof input.id !== "string" || dialingIds.has(input.id)) return json(res, 409, { error: "This interview is already being dispatched" });
      dialingIds.add(input.id);
      try {
      const run = await store.find(input.id);
      if (!run || run.status !== "ready" || !prepared.has(run.id)) return json(res, 409, { error: "Prepare a new interview before dialing; existing attempts are never redialed" });
      // Selection is fixed by preparation; no HTTP request can supply a recipient.
      try { await preflight(); }
      catch (error) { await store.update(run.id, { status: "failed", failure: failure(error) }); prepared.delete(run.id); throw error; }
      const dialing = await store.update(run.id, { status: "dialing" });
      if (dialing.status !== "dialing") throw new Error("Call reservation is no longer dialable");
      try {
        const call = await provider.calls.create({ from: config.from, to: config.to,
          url: `${config.publicOrigin}/interview/answer/${run.id}`, method: "POST",
          statusCallback: `${config.publicOrigin}/interview/status/${run.id}`, statusCallbackMethod: "POST",
          statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
          timeout: 25, timeLimit: config.maxSeconds, record: false,
        });
        const updated = await store.update(run.id, { callSid: call.sid, status: "queued" });
        return json(res, 200, { run: updated });
      } catch (error) {
        // A timeout is ambiguous: do not retry calls.create or release its reservation.
        const status = (error as { status?: number }).status;
        await store.update(run.id, { status: status && status >= 400 && status < 500 ? "failed" : "unknown", failure: failure(error) });
        throw error;
      }
      } finally { dialingIds.delete(input.id); }
    }
    if (pathname === "/internal/end") { await stopCall(input.id, "operator_requested"); return json(res, 200, { run: await store.find(input.id) }); }
    if (pathname === "/internal/reconcile") {
      const run = await store.find(input.id);
      if (!run?.callSid) throw new Error("A verified call SID is required for reconciliation");
      const call = await provider.calls(run.callSid).fetch();
      if (call.to !== config.to || call.from !== config.from) throw new Error("Call identity mismatch");
      const updated = callbackStates.has(call.status) ? await store.update(run.id, { status: call.status as "completed" }) : run;
      return json(res, 200, { run: updated });
    }
    return json(res, 404, { error: "Not found" });
  }
  const route = pathname.match(/^\/interview\/(answer|status)\/([0-9a-f-]{36})$/);
  if (!route || req.method !== "POST") return json(res, 404, { error: "Not found" });
  const params = Object.fromEntries(new URLSearchParams(await body(req)));
  if (!validTwilioRequest(config, req.headers["x-twilio-signature"] as string | undefined, pathname, params)
      || params.AccountSid !== config.accountSid) return json(res, 403, { error: "Invalid callback" });
  let run = await store.find(route[2]);
  if (!run) return json(res, 404, { error: "Unknown interview" });
  if (!run.callSid && ["dialing", "unknown"].includes(run.status) && params.From === config.from && params.To === config.to && /^CA[0-9a-f]{32}$/i.test(params.CallSid || "")) {
    run = await store.update(run.id, { callSid: params.CallSid });
  }
  if (params.CallSid !== run.callSid) return json(res, 403, { error: "Call mismatch" });
  if (route[1] === "status") {
    if (callbackStates.has(params.CallStatus)) await store.update(run.id, { status: params.CallStatus as "completed" });
    await store.markEvent(run.id, { type: "twilio.status", status: params.CallStatus, duration: params.CallDuration || null });
    if (terminal.has(params.CallStatus)) { await active.get(run.id)?.stop("provider_terminal"); prepared.delete(run.id); }
    return json(res, 200, { ok: true });
  }
  if (terminal.has(run.status) || !prepared.has(run.id)) {
    res.writeHead(200, { "content-type": "text/xml" }); return res.end("<Response><Hangup/></Response>");
  }
  res.writeHead(200, { "content-type": "text/xml", "cache-control": "no-store" });
  return res.end(answerXml(config.publicOrigin, run.id, streamToken(run.id, run.callSid!)));
}

const server = createServer((req, res) => { handle(req, res).catch((error) => json(res, 503, { error: failure(error) })); });
server.requestTimeout = 30_000;
const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const claimedStreams = new Set<string>();
server.on("upgrade", (req, socket, head) => {
  const pathname = req.url || "";
  if (!accepting || !/^\/interview\/media\/[0-9a-f-]{36}$/.test(pathname)
      || !validTwilioRequest(config, req.headers["x-twilio-signature"] as string | undefined, pathname, {}, true)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req));
});
sockets.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  // Twilio can send its start frame immediately after the upgrade.
  ws.pause();
  ws.on("error", () => { /* The call-specific handler below records established streams. */ });
  void connectMedia(ws, req).catch(() => ws.close(1011));
});
async function connectMedia(ws: WebSocket, req: IncomingMessage) {
  const id = req.url!.split("/").at(-1)!;
  if (claimedStreams.has(id)) { ws.close(1008); return; }
  claimedStreams.add(id);
  ws.once("close", () => claimedStreams.delete(id));
  const run = await store.find(id);
  const packet = prepared.get(id);
  if (!run?.callSid || !packet || terminal.has(run.status) || active.has(id)) { ws.close(1008); return; }
  let streamSid: string | undefined;
  let live: ReturnType<typeof createLiveInterview> | undefined;
  let stopping = false;
  let endingAt: number | undefined;
  let goodbyeMark: string | undefined;
  let goodbyeTimer: NodeJS.Timeout | undefined;
  let lastAudioAt = 0;
  let lastSpeechAt = 0;
  let inputBytes = 0;
  const receipts = new PlaybackReceipts();
  const audioRoot = path.join(root, id);
  await fs.mkdir(audioRoot, { recursive: true, mode: 0o700 });
  const inputAudio = createWriteStream(path.join(audioRoot, "caller.mulaw"), { mode: 0o600 });
  const outputAudio = createWriteStream(path.join(audioRoot, "reporter.mulaw"), { mode: 0o600 });
  const event = (value: Record<string, unknown>) => { void store.markEvent(id, value as { type: string }).catch(() => stop("recording_error")); };
  const finishTimer = setTimeout(() => { void stop("duration_limit"); }, config.maxSeconds * 1000);
  const startTimer = setTimeout(() => { if (!streamSid) void stop("media_start_timeout"); }, 8_000);
  async function stop(reason: string) {
    if (stopping) return;
    stopping = true;
    clearTimeout(finishTimer); clearTimeout(startTimer); clearTimeout(goodbyeTimer);
    const closingVoice = live?.close(reason);
    inputAudio.end(); outputAudio.end();
    if (ws.readyState === WebSocket.OPEN) ws.close();
    active.delete(id); prepared.delete(id);
    // Provider termination must remain possible when disk recording has failed.
    const persistence = Promise.allSettled([
      store.markEvent(id, { type: "call.stopped", reason, sentAudioMs: receipts.sentBytes / 8, acknowledgedAudioMs: receipts.playedBytes / 8, receivedAudioMs: inputBytes / 8 }),
      store.update(id, { audioMs: receipts.sentBytes / 8 }),
    ]);
    if (reason !== "provider_terminal") {
      try {
        const current = await store.find(id).catch(() => null);
        if (!current || !terminal.has(current.status)) {
          const ended = await provider.calls(run!.callSid!).update({ status: "completed" });
          await store.update(id, { status: ended.status === "completed" ? "completed" : "unknown" });
        }
      } catch (error) { await store.update(id, { status: "unknown", failure: failure(error) }).catch(() => undefined); }
    }
    await Promise.allSettled([persistence, closingVoice]);
  }
  active.set(id, { stop });
  inputAudio.on("error", () => { void stop("audio_write_error"); });
  outputAudio.on("error", () => { void stop("audio_write_error"); });
  ws.on("message", (raw) => {
    if (stopping) return;
    try {
      const message = JSON.parse(raw.toString());
      if (message.event === "start") {
        if (streamSid) throw new Error("Repeated stream start");
        streamSid = validateMediaStart(message.start, { accountSid: config.accountSid, callSid: run.callSid!, token: streamToken(id, run.callSid!) });
        clearTimeout(startTimer);
        event({ type: "twilio.stream.started", streamSid });
        live = createLiveInterview({ apiKey: config.apiKey, prepared: packet, voice: config.voice, backendModel: config.backendModel,
          onReady: () => { event({ type: "voice.ready" }); },
          onAudio: (payload) => {
            if (stopping || ws.readyState !== WebSocket.OPEN || !streamSid) return;
            const bytes = Buffer.from(payload, "base64");
            // Twilio owns playback. Marks bound its outstanding queue without cutting off full-duplex backchannels.
            if (ws.bufferedAmount > 256_000 || receipts.pendingCount > 250 || receipts.backlogMs > 5_000) { void stop("audio_backpressure"); return; }
            outputAudio.write(bytes);
            ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
            const name = receipts.sent(bytes.length);
            ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name } }));
            lastAudioAt = Date.now();
            if (endingAt) goodbyeMark = name;
          },
          onEvent: (value) => {
            event(value);
            if (value.type === "session.output_transcript.delta") lastSpeechAt = Date.now();
            if (value.type === "session.started" && typeof value.sessionId === "string") void store.update(id, { liveSessionId: value.sessionId }).catch(() => stop("recording_error"));
            if (value.type === "session.closed") void store.update(id, { finalized: true, finalUsage: value.usage }).catch(() => stop("recording_error"));
          },
          onClosed: (finalized) => { void store.update(id, { finalized }).catch(() => undefined).then(() => stop("voice_closed")); },
          onEndRequested: () => {
            if (endingAt) return;
            endingAt = Date.now();
            // Wait for the goodbye's actual Twilio mark, with a bounded fallback.
            goodbyeTimer = setInterval(() => {
              if ((goodbyeMark && receipts.pendingCount === 0 && Date.now() - lastAudioAt > 1800)
                  || (lastSpeechAt > endingAt! && Date.now() - lastSpeechAt > 2000 && receipts.backlogMs < 300)
                  || Date.now() - endingAt! > 12_000) void stop("interview_finished");
            }, 250);
          },
        });
      } else if (message.event === "media" && streamSid && message.streamSid === streamSid) {
        if (message.media?.track !== "inbound" || typeof message.media.payload !== "string"
            || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.media.payload) || message.media.payload.length > 32768) throw new Error("Invalid input audio");
        const bytes = Buffer.from(message.media.payload, "base64"); inputBytes += bytes.length;
        if (inputBytes > (config.maxSeconds + 10) * 8000) throw new Error("Audio duration exceeded");
        inputAudio.write(bytes); live?.appendAudio(message.media.payload);
      } else if (message.event === "mark" && message.streamSid === streamSid) {
        receipts.acknowledge(message.mark?.name);
      } else if (message.event === "stop") { void stop("caller_hangup"); }
    } catch (error) { event({ type: "media.error", ...failure(error) }); void stop("media_error"); }
  });
  ws.on("close", () => { void stop("media_disconnected"); });
  ws.on("error", () => { void stop("media_socket_error"); });
  ws.resume();
}

async function main() {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  // No call is retried after a restart. Provider outcomes with a SID can be reconciled by the operator.
  for (const run of await store.list(100)) {
    if (["preparing", "ready"].includes(run.status)) await store.update(run.id, { status: "failed", failure: { code: "service_restart", message: "Prepare the interview again after restart" } });
    else if (!terminal.has(run.status)) await store.update(run.id, { status: "unknown" });
  }
  server.listen(config.port, "127.0.0.1", () => console.log(JSON.stringify({ service: "league-interview", port: config.port, model: "gpt-live-1" })));
}
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  accepting = false; server.close();
  const deadline = setTimeout(() => process.exit(1), 25_000);
  void Promise.allSettled([...active.values()].map((call) => call.stop("service_shutdown"))).then(() => { clearTimeout(deadline); process.exit(0); });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
void main().catch((error) => { console.error(JSON.stringify(failure(error))); process.exitCode = 1; });
