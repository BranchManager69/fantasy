import { NextResponse } from "next/server";
import { studioAuthorized, studioHeaders } from "@/server/league-studio-auth";
import { LeagueStudioStore, STUDIO_LIMITS } from "@/server/league-studio-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await studioAuthorized(request)) return NextResponse.json({ error: "Sign in to read saved messages" }, { status: 401, headers: studioHeaders });
  try {
    // Each request selects exactly one canonical message, never a complete import.
    const id = (await context.params).id;
    const match = /^msg-([a-f0-9]{64})-(\d{5})$/.exec(id);
    if (!match || Number(match[2]) >= STUDIO_LIMITS.messagesPerImport) throw new Error("Invalid message");
    const store = new LeagueStudioStore();
    const importId = `src-${match[1]}`;
    const source = (await store.read()).imports.find((entry) => entry.id === importId);
    if (!source) throw new Error("Unknown source");
    const chunks = await store.listChunks(importId);
    const message = chunks.flatMap((chunk) => chunk.messages).find((entry) => entry.id === id && entry.index === Number(match[2]));
    if (!message || message.text.length > STUDIO_LIMITS.chunkChars) throw new Error("Unknown message");
    const result = { source: { id: source.id, label: source.label },
      message: { id: message.id, author: message.author, timestamp: message.timestamp, text: message.text } };
    if (Buffer.byteLength(JSON.stringify(result)) > 80_000) throw new Error("Message exceeds the response limit");
    return NextResponse.json(result, { headers: studioHeaders });
  } catch {
    return NextResponse.json({ error: "This saved message is unavailable" }, { status: 404, headers: studioHeaders });
  }
}
