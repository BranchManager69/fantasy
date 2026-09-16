import { NextResponse } from "next/server";
import { createStudioSession, sameOrigin, studioAuthorized, studioHeaders, STUDIO_COOKIE } from "@/server/league-studio-auth";
import { readRequestJson } from "@/server/league-studio-core";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const authorized = await studioAuthorized(request).catch(() => false);
  return NextResponse.json({ authorized }, { headers: studioHeaders });
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Open the studio to sign in" }, { status: 403, headers: studioHeaders });
  try {
    const body = await readRequestJson(request, 2000);
    const session = await createStudioSession(typeof body.token === "string" ? body.token : "");
    const response = NextResponse.json({ ok: true }, { headers: studioHeaders });
    response.cookies.set(STUDIO_COOKIE, session, { httpOnly: true, sameSite: "strict", secure: new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https", path: "/api/studio", maxAge: 7 * 86400 });
    return response;
  } catch { return NextResponse.json({ error: "That access code did not match" }, { status: 401, headers: studioHeaders }); }
}
export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Open the studio to sign out" }, { status: 403, headers: studioHeaders });
  const response = NextResponse.json({ ok: true }, { headers: studioHeaders });
  response.cookies.set(STUDIO_COOKIE, "", { path: "/api/studio", maxAge: 0 });
  return response;
}
