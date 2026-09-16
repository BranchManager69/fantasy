import { NextResponse } from "next/server";
import { studioAuthorized, studioHeaders } from "@/server/league-studio-auth";
import { readStudioAsset } from "@/server/league-studio-core";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await studioAuthorized(request)) return NextResponse.json({ error: "Sign in to view studio images" }, { status: 401, headers: studioHeaders });
  try {
    const { bytes, asset } = await readStudioAsset((await context.params).id);
    return new Response(new Uint8Array(bytes), { headers: { ...studioHeaders, "content-type": asset.mime, "content-disposition": "inline" } });
  } catch { return NextResponse.json({ error: "Image unavailable" }, { status: 404, headers: studioHeaders }); }
}
