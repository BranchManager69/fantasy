import OpenAI from "openai";
import type { AgentSession } from "openai/resources/beta/agents/agents";
import type { AnalystBudget } from "./analyst-budget";

type CleanupOptions = { client: OpenAI; budget: AnalystBudget; now?: () => Date };
const recoveries = new WeakMap<AnalystBudget, Promise<boolean>>();
const requestOptions = () => ({ timeout: 5_000, maxRetries: 0, signal: AbortSignal.timeout(5_000) });
const notFound = (error: unknown) => error instanceof OpenAI.APIError && error.status === 404;

/** A pending cleanup gets one bounded attempt; elapsed time alone never unlocks it. */
export function recoverPendingAnalystCleanup(options: CleanupOptions): Promise<boolean> {
  const existing = recoveries.get(options.budget);
  if (existing) return existing;
  const attempt = recover(options).finally(() => recoveries.delete(options.budget));
  recoveries.set(options.budget, attempt);
  return attempt;
}

async function recover({ client, budget, now = () => new Date() }: CleanupOptions): Promise<boolean> {
  const receipt = await budget.activeReceipt();
  if (!receipt || receipt.status !== "cleanup_pending"
    || now().getTime() - Date.parse(receipt.updatedAt) < 5_000) return false;

  // Mark the attempt before network I/O; a restart never turns uncertain cleanup
  // into permission for another charged session.
  await budget.record(receipt.runId, { stage: "cleaning_up" });
  let sessionId = receipt.sessionId;
  let verified = false;
  try {
    let session: AgentSession | undefined;
    if (sessionId) {
      try { session = await client.beta.agents.sessions.retrieve(sessionId, requestOptions()); }
      catch (error) { if (notFound(error)) verified = true; else throw error; }
    } else {
      const recent = await client.beta.agents.sessions.list({ limit: 100, order: "desc" }, requestOptions());
      const matches = recent.data.filter((candidate) => candidate.metadata?.run_id === receipt.runId
        && candidate.metadata.application === "fantasy-2026");
      // An absent or ambiguous match is not proof that a session was never created.
      if (matches.length === 1) {
        session = matches[0];
        sessionId = session.id;
        await budget.record(receipt.runId, { sessionId });
      }
    }
    if (session && sessionId) {
      if (session.id !== sessionId || session.metadata?.run_id !== receipt.runId
        || session.metadata.application !== "fantasy-2026") {
        throw new Error("The remote session does not match this analyst reservation.");
      }
      if (session.status === "in_progress" || session.status === "requires_action") {
        try {
          await client.beta.agents.sessions.events.create(sessionId,
            { events: [{ type: "agent.session.input.cancel" }] }, requestOptions());
        } catch { /* Deletion is an independent cleanup check. */ }
      }
      try {
        const deleted = await client.beta.agents.sessions.delete(sessionId, requestOptions());
        verified = deleted.deleted === true;
      } catch (error) { if (notFound(error)) verified = true; else throw error; }
    }
  } catch {
    // Preserve the receipt and budget after provider errors, including 409 or timeout.
  }

  if (!verified) {
    await budget.record(receipt.runId, { status: "cleanup_pending", stage: "cleaning_up" });
    return false;
  }
  const status = receipt.errorCode === "none" ? "completed" : receipt.errorCode ? "failed" : "cleanup_recovered";
  await budget.record(receipt.runId, { status, stage: status, cleanupVerified: true });
  try { await budget.finish(receipt.runId, { cleanupVerified: true }); }
  catch (error) {
    await budget.record(receipt.runId, { status: "cleanup_pending", stage: "cleaning_up" });
    throw error;
  }
  return true;
}
