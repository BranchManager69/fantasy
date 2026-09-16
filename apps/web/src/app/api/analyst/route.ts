import OpenAI from "openai";
import path from "node:path";
import { NextResponse } from "next/server";
import { getDataRoot } from "@/lib/paths";
import { AnalystBudget, AnalystBudgetError } from "@/server/analyst-budget";
import { createAnalystContext } from "@/server/analyst-context";
import { AnalystRunError, runAnalyst } from "@/server/analyst-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;
const budget = new AnalystBudget({ directory: path.join(getDataRoot(), "history", "analyst") });
const headers = { "cache-control": "no-store" };

export async function GET() {
  return NextResponse.json({ enabled: Boolean(process.env.OPENAI_API_KEY), ...await budget.status() }, { headers });
}

async function readSmallBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("No question supplied");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 6_000) { await reader.cancel(); throw new Error("Question is too long"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "The league analyst is not connected yet." }, { status: 503, headers });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin && origin !== `https://${request.headers.get("host")}`) {
    return NextResponse.json({ error: "Open the league website to ask a question." }, { status: 403, headers });
  }
  let body;
  try { body = await readSmallBody(request); } catch { return NextResponse.json({ error: "Enter a question of at most 1,200 characters." }, { status: 400, headers }); }
  const { season, week, teamId } = body ?? {};
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!Number.isInteger(season) || season < 2000 || season > 2100 || !Number.isInteger(week) || week < 1 || week > 18 || !Number.isInteger(teamId) || !question || question.length > 1200) {
    return NextResponse.json({ error: "Choose a team and enter a question of at most 1,200 characters." }, { status: 400, headers });
  }
  try {
    const context = await createAnalystContext(season, week, teamId);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 20_000 });
    const result = await runAnalyst({ client, budget, context, question, season, week, teamId, signal: request.signal });
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof AnalystBudgetError) return NextResponse.json({ error: error.message }, { status: 429, headers });
    if (error instanceof AnalystRunError) return NextResponse.json({ error: error.message }, { status: 503, headers });
    console.error("fantasy_analyst_unavailable", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "The selected week's evidence is unavailable. Please try again later." }, { status: 503, headers });
  }
}
