import { NextResponse } from "next/server";
import { studioAuthorized, sameOrigin, studioHeaders } from "@/server/league-studio-auth";
import { saveStudioAsset } from "@/server/league-studio-core";
import { studioStore } from "@/server/league-studio-service";
import { loadLeagueWeek } from "@/lib/league-week";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!sameOrigin(request) || !await studioAuthorized(request)) return NextResponse.json({ error: "Sign in to the private studio" }, { status: 401, headers: studioHeaders });
  try {
    // Bound the full multipart body before the framework buffers it.
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Choose an image");
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 11 * 1024 * 1024) throw new Error("Images must be at most 10 MB"); chunks.push(value); } }
    finally { await reader.cancel().catch(() => undefined); }
    const parsed = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type") || "" } }).formData();
    const file = parsed.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Choose an image");
    const memberId = String(parsed.get("memberId") || "") || undefined;
    const playerValue = parsed.get("playerId");
    const playerId = playerValue ? Number(playerValue) : undefined;
    if (Boolean(memberId) === Boolean(playerId)) throw new Error("Assign the photo to one GM or player");
    const profiles = (await studioStore.read()).profiles;
    const profile = memberId ? profiles.find((p) => p.id === memberId) : undefined;
    if (memberId && !profile) throw new Error("Save this GM's profile before adding a photo");
    if (playerId) {
      const { report } = await loadLeagueWeek(2026, 1);
      if (!report?.teams.some((team) => team.players.some((player) => player.id === playerId))) throw new Error("Choose a player in this league");
    }
    const kind = parsed.get("kind") === "portrait" ? "portrait" : "reference";
    const asset = await saveStudioAsset(Buffer.from(await file.arrayBuffer()), { label: String(parsed.get("label") || file.name).slice(0, 120), kind, memberId, playerId });
    if (profile) await studioStore.appendProfileAsset(profile.id, { id: asset.id, kind, label: asset.label });
    return NextResponse.json({ asset }, { headers: studioHeaders });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save the image" }, { status: 400, headers: studioHeaders }); }
}
