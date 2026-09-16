import { NextResponse } from "next/server";
import { sameOrigin, studioAuthorized, studioHeaders } from "@/server/league-studio-auth";
import { readRequestJson } from "@/server/league-studio-core";
import { studioPhotos } from "@/server/league-studio-photos";
import { photoError } from "@/server/league-studio-photo-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  if (!await studioAuthorized(request)) return NextResponse.json({ error: "Sign in to view your photos" }, { status: 401, headers: studioHeaders });
  try { return NextResponse.json({ photo: await studioPhotos.read((await context.params).id) }, { headers: studioHeaders }); }
  catch (error) { return photoError(error); }
}
export async function PATCH(request: Request, context: Context) {
  if (!sameOrigin(request) || !await studioAuthorized(request)) return NextResponse.json({ error: "Sign in to label photos" }, { status: 401, headers: studioHeaders });
  try {
    const body = await readRequestJson(request, 32 * 1024);
    return NextResponse.json({ photo: await studioPhotos.update((await context.params).id, body) }, { headers: studioHeaders });
  } catch (error) { return photoError(error); }
}
