import OpenAI from "openai";
import type { AgentSessionItem, AgentToolParam, TokenUsage } from "openai/resources/beta/agents/agents";
import type { AnalystBudget } from "./analyst-budget";
import { analystWriter } from "./analyst-writer";

export interface AnalystContext {
  tools: AgentToolParam[];
  call(name: string, args: unknown): Promise<unknown>;
  sources: { label: string; url: string }[];
  initialEvidence?: string;
  evidenceLabel?: string;
}

export type AnalystProgress = { runId: string; stage: string; message: string; elapsedMs: number };

export class AnalystRunError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function finalText(items: AgentSessionItem[], turnId: string): string {
  const messages = items.filter((item) => item.type === "message" && item.role === "assistant" && item.turn_id === turnId);
  const finals = messages.filter((item) => "phase" in item && item.phase === "final_answer");
  const candidates = finals.length ? finals : messages.filter((item) => !('phase' in item) || item.phase === null);
  return candidates.map((item) => item.type === "message" ? item.content.filter((part) => part.type === "output_text").map((part) => "text" in part ? part.text : "").join("") : "").join("\n\n").trim();
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runAnalyst(options: {
  client: OpenAI; budget: AnalystBudget; context: AnalystContext;
  question: string; season: number; week: number; teamId: number;
  signal?: AbortSignal; timeoutMs?: number;
  writer?: { model: string; instructions: string };
  maxOutputChars?: number;
  onProgress?: (progress: AnalystProgress) => void | Promise<void>;
}) {
  const { client, budget, context } = options;
  const maxOutputChars = Math.min(options.maxOutputChars ?? 14_000, 32_000);
  if (!Number.isInteger(maxOutputChars) || maxOutputChars < 1) {
    throw new AnalystRunError("invalid_output_limit", "The analyst response limit is invalid.");
  }
  const runId = await budget.reserve();
  const startedAt = Date.now();
  const abort = new AbortController();
  let abortCause: "timeout" | "disconnected" = "timeout";
  const timeout = setTimeout(() => abort.abort(), options.timeoutMs ?? 180_000);
  const onDisconnect = () => {
    if (!abort.signal.aborted) { abortCause = "disconnected"; abort.abort(); }
  };
  options.signal?.addEventListener("abort", onDisconnect, { once: true });
  if (options.signal?.aborted) onDisconnect();
  let sessionId: string | undefined;
  let turnId: string | undefined;
  let createAttempted = false;
  let noRemoteSessionCreated = false;
  let terminal = false;
  let usage: TokenUsage | null = null;
  let status = "failed";
  let errorCode = "unknown";
  let cleanupVerified = false;
  let cleanupPending = true;
  let stream: Awaited<ReturnType<typeof client.beta.agents.sessions.events.stream>> | undefined;
  const items: AgentSessionItem[] = [];
  const handled = new Set<string>();
  const toolNames = new Set<string>();
  let commandCount = 0;
  let searchCount = 0;
  let textLength = 0;
  let currentStage = "creating";
  const progress = async (stage: string, message: string) => {
    currentStage = stage;
    await budget.record(runId, { stage, toolNames: [...toolNames] });
    const update = { runId, stage, message, elapsedMs: Date.now() - startedAt };
    console.info(JSON.stringify({ event: "fantasy_analyst_progress", ...update }));
    try { await options.onProgress?.(update); } catch { /* Observer failures cannot skip remote cleanup. */ }
  };
  try {
    abort.signal.throwIfAborted();
    if (context.initialEvidence && Buffer.byteLength(context.initialEvidence, "utf8") > 24_000) {
      throw new AnalystRunError("evidence_limit", "The evidence packet is too large.");
    }
    if (context.initialEvidence) toolNames.add(context.evidenceLabel ?? "prefetched_matchup");
    const input = context.initialEvidence
      ? JSON.stringify({ question: options.question, verifiedEvidence: JSON.parse(context.initialEvidence) })
      : options.question;
    await progress("creating", "Connecting to the analyst...");
    abort.signal.throwIfAborted();
    const writer = options.writer ?? analystWriter();
    createAttempted = true;
    stream = await client.beta.agents.sessions.create({
      agent: {
        ...writer, reasoning: { effort: "low" },
        text: { verbosity: "low" }, multi_agent: { enabled: false },
        tools: [...context.tools, { type: "web_search", mode: "live", context_size: "low" }],
      },
      environment: { type: "openai_hosted", network: { access: "disabled" } },
      metadata: { application: "fantasy-2026", run_id: runId, season: String(options.season), week: String(options.week), team: String(options.teamId) },
      input,
      stream: true,
    }, { signal: abort.signal, maxRetries: 0 });
    for await (const event of stream) {
      if (!sessionId) {
        sessionId = event.type === "agent.session.created" ? event.session.id : "session_id" in event ? event.session_id : undefined;
        if (sessionId) await budget.record(runId, { sessionId });
      }
      if (event.type === "agent.session.turn.created" && !event.turn.subagent_id) {
        turnId = event.turn_id;
        await budget.record(runId, { turnId });
        await progress("researching", "Reading your question and the league evidence...");
      }
      if (event.type === "agent.session.requires_action") {
        for (const action of event.session.required_actions) {
          if (action.type !== "function_call") continue;
          const key = `${action.turn_id}:${action.call_id}`;
          if (handled.has(key)) continue;
          if (handled.size >= 6) throw new AnalystRunError("tool_limit", "The analyst reached its research limit. Try a narrower question.");
          handled.add(key);
          if (!turnId) { turnId = action.turn_id; await budget.record(runId, { turnId }); }
          const labels: Record<string, string> = {
            get_matchup: "Reading the matchup and official scores...",
            get_bench_alternatives: "Checking your bench alternatives...",
            get_best_lineup: "Checking every eligible lineup for a path to victory...",
            get_game_moments: "Looking at the plays behind the result...",
            get_league_timeline: "Comparing what happened across the league...",
          };
          await progress("researching", labels[action.name] ?? "Checking the supporting evidence...");
          const result = await context.call(action.name, action.arguments);
          const output = JSON.stringify(result);
          if (output.length > 45_000) throw new AnalystRunError("evidence_limit", "This question needs a smaller evidence set.");
          toolNames.add(action.name);
          await budget.record(runId, { toolNames: [...toolNames] });
          await client.beta.agents.sessions.events.create(sessionId!, {
            events: [{ type: "agent.session.input.tool_result", turn_id: action.turn_id, call_id: action.call_id, success: true, output }],
            "Idempotency-Key": `${runId}-${action.call_id}`,
          }, { signal: abort.signal, maxRetries: 0 });
        }
      }
      if (event.type === "agent.session.turn.item.added" && event.item.type === "command_execution") {
        if (++commandCount > 3) throw new AnalystRunError("command_limit", "The analyst reached its calculation limit.");
      }
      if (event.type === "agent.session.turn.item.added" && event.item.type === "web_search_call") {
        if (++searchCount > 3) throw new AnalystRunError("search_limit", "The analyst reached its research limit. Try a more specific question.");
        toolNames.add("web_search");
        await progress("researching", "Looking up supporting NFL reporting...");
      }
      if (event.type === "agent.session.turn.item.added" && event.item.type === "message"
        && event.item.role === "assistant" && "phase" in event.item && event.item.phase === "final_answer") {
        await progress("answering", "Writing your answer...");
      }
      if (event.type === "agent.session.turn.item.done") {
        items.push(event.item);
        if (event.item.type === "command_execution" && event.item.exit_code === 0) toolNames.add("sandbox_calculation");
      }
      if (event.type === "agent.session.turn.output_text.delta") {
        textLength += event.delta.length;
        if (textLength > maxOutputChars) throw new AnalystRunError("output_limit", "The answer grew too long. Try a narrower question.");
        if (currentStage !== "answering") await progress("answering", "Writing the analysis...");
      }
      if (event.type === "agent.session.turn.completed" || event.type === "agent.session.turn.failed" || event.type === "agent.session.turn.cancelled") {
        if (event.turn.subagent_id || (turnId && event.turn_id !== turnId)) continue;
        turnId = event.turn_id;
        usage = event.usage ?? event.turn.usage ?? null;
        terminal = true;
        if (event.type !== "agent.session.turn.completed") throw new AnalystRunError(event.turn.error?.code ?? "cancelled", "The analyst could not finish this question.");
        break;
      }
      if (event.type === "agent.session.failed" || event.type === "agent.session.environment.failed") {
        throw new AnalystRunError("environment_failed", "OpenAI could not start the analyst's workspace.");
      }
    }
    abort.signal.throwIfAborted();
    if (!sessionId || !turnId) throw new AnalystRunError("missing_turn", "The analyst connection ended before a result was confirmed.");
    if (!terminal) {
      const turn = await client.beta.agents.sessions.turns.retrieve(turnId, { session_id: sessionId }, { signal: abort.signal, maxRetries: 0 });
      terminal = ["completed", "failed", "cancelled"].includes(turn.status);
      usage = turn.usage ?? null;
      if (turn.status !== "completed") throw new AnalystRunError("incomplete_turn", "The analyst connection ended before the answer was complete.");
    }
    let answer = finalText(items, turnId);
    let savedItems: AgentSessionItem[] = [];
    // Completed text survives optional accounting/telemetry failures. If text is
    // missing, retrieving it remains part of the bounded answer operation.
    if (!answer) {
      const saved = await client.beta.agents.sessions.items.list(sessionId, { order: "desc", limit: 100 }, { signal: abort.signal, maxRetries: 0 });
      savedItems = saved.data;
      answer = finalText([...saved.data].reverse(), turnId);
      abort.signal.throwIfAborted();
    }
    if (!answer || (!context.initialEvidence && !toolNames.has("get_matchup"))) throw new AnalystRunError("missing_evidence", "The analyst did not return a verified answer. Please try again later.");
    if (answer.length > maxOutputChars) throw new AnalystRunError("output_limit", "The answer exceeded the response limit.");
    clearTimeout(timeout);
    status = "completed";
    try { await progress("finalizing", "The answer is ready. Finishing the request..."); }
    catch { /* Optional progress persistence cannot discard validated final text. */ }
    for (const item of savedItems) {
      if (item.turn_id === turnId && item.type === "command_execution" && item.exit_code === 0) toolNames.add("sandbox_calculation");
    }
    if (!usage) {
      try {
        const latest = await client.beta.agents.sessions.turns.retrieve(turnId, { session_id: sessionId }, { timeout: 3_000, signal: AbortSignal.timeout(3_000), maxRetries: 0 });
        usage = latest.usage ?? null;
      } catch { /* Token accounting is best effort and never discards an answer. */ }
    }
    return { answer, sources: context.sources, runId, toolsUsed: [...toolNames], get cleanupPending() { return cleanupPending; } };
  } catch (error) {
    if (!createAttempted) noRemoteSessionCreated = true;
    if (!sessionId && error instanceof OpenAI.APIError && error.status && error.status >= 400 && error.status < 500 && error.status !== 408) noRemoteSessionCreated = true;
    errorCode = abort.signal.aborted ? abortCause : error instanceof AnalystRunError ? error.code
      : error instanceof OpenAI.APIError ? String(error.code ?? error.status ?? "connection_error") : "connection_error";
    if (abort.signal.aborted) throw new AnalystRunError(abortCause, abortCause === "timeout"
      ? "The analyst reached its time limit. Your question is saved above; you can retry once cleanup finishes."
      : "The request was disconnected before the answer finished.");
    if (error instanceof AnalystRunError) throw error;
    if (error instanceof OpenAI.APIError && error.status === 429) throw new AnalystRunError("provider_limit", "OpenAI could not accept this request. The account may need credits or a rate-limit reset.");
    if (error instanceof OpenAI.APIError && (error.status === 401 || error.status === 403)) throw new AnalystRunError("provider_access", "The configured OpenAI key does not currently have access to the Agents API.");
    throw new AnalystRunError("provider_error", "The analyst could not complete the request. Please try again later.");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onDisconnect);
    stream?.controller.abort();
    try { await progress("cleaning_up", status === "completed" ? "Closing the analysis session..." : "Closing the unfinished request..."); }
    catch { /* A local progress write must never prevent remote cleanup. */ }
    // An aborted observer never implies a cancelled server turn. Reconcile an
    // ambiguous create once, then cancel/delete using fresh, bounded requests.
    if (!sessionId && createAttempted && !noRemoteSessionCreated) {
      try {
        const recent = await client.beta.agents.sessions.list({ limit: 100, order: "desc" }, { timeout: 8_000, signal: AbortSignal.timeout(8_000), maxRetries: 0 });
        sessionId = recent.data.find((session) => session.metadata.run_id === runId && session.metadata.application === "fantasy-2026")?.id;
      } catch { /* Keep the durable gate closed when the remote outcome is unknown. */ }
    }
    if (sessionId) {
      if (!terminal) {
        try { await client.beta.agents.sessions.events.create(sessionId, { events: [{ type: "agent.session.input.cancel" }] }, { timeout: 8_000, signal: AbortSignal.timeout(8_000), maxRetries: 0 }); } catch { /* Deletion below is the independent cleanup check. */ }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const deleted = await client.beta.agents.sessions.delete(sessionId, { timeout: 8_000, signal: AbortSignal.timeout(8_000), maxRetries: 0 });
          cleanupVerified = deleted.deleted === true;
          break;
        } catch (error) {
          if (error instanceof OpenAI.APIError && error.status === 404) { cleanupVerified = true; break; }
          console.info(JSON.stringify({ event: "fantasy_analyst_cleanup_retry", runId, attempt, httpStatus: error instanceof OpenAI.APIError ? error.status : null, code: error instanceof OpenAI.APIError ? error.code ?? "connection_error" : "connection_error" }));
          if (!(error instanceof OpenAI.APIError && error.status === 409)) break;
          await pause(500 * (attempt + 1));
        }
      }
    }
    try { await budget.record(runId, { usage }); }
    catch { usage = null; console.info(JSON.stringify({ event: "fantasy_analyst_accounting_pending", runId })); }
    try {
      await budget.record(runId, { sessionId, turnId, status: cleanupVerified || noRemoteSessionCreated ? status : "cleanup_pending", stage: cleanupVerified || noRemoteSessionCreated ? status : "cleaning_up", errorCode: status === "completed" ? "none" : errorCode, toolNames: [...toolNames], cleanupVerified });
    } catch { console.info(JSON.stringify({ event: "fantasy_analyst_receipt_pending", runId })); }
    // Error codes are safe operational metadata; neither question nor key is logged.
    console.info(JSON.stringify({ event: "fantasy_analyst_run", runId, sessionId, turnId, status, errorCode: status === "completed" ? null : errorCode, cleanupVerified, usage }));
    if (cleanupVerified || noRemoteSessionCreated) {
      try {
        await budget.finish(runId, { cleanupVerified, noRemoteSessionCreated });
        cleanupPending = false;
      } catch {
        try { await budget.record(runId, { status: "cleanup_pending", stage: "cleaning_up" }); }
        catch { /* Preserve the lock when local persistence is unavailable. */ }
        console.info(JSON.stringify({ event: "fantasy_analyst_release_pending", runId, cleanupVerified }));
      }
    }
    if (!cleanupPending) {
      try { await options.onProgress?.({ runId, stage: status, message: status === "completed" ? "Answer ready." : "The request has ended.", elapsedMs: Date.now() - startedAt }); } catch { /* Observer may have disconnected. */ }
    } else if (status !== "completed") throw new AnalystRunError("cleanup_pending", "The request could not finish and its session is still closing. Availability will refresh automatically.");
  }
}
