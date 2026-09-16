import { NextResponse } from "next/server";
import { publicMediaHeaders, publicMediaWeek, readPublicLeagueImage } from "@/server/league-public-media";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const selection = publicMediaWeek(new URL(request.url).searchParams);
  if (!selection) return NextResponse.json({ error: "Image unavailable" }, { status: 404, headers: publicMediaHeaders });
  try {
    const image = await readPublicLeagueImage(selection, (await context.params).id);
    if (!image) return NextResponse.json({ error: "Image unavailable" }, { status: 404, headers: publicMediaHeaders });
    const headers = { ...publicMediaHeaders, "cache-control": "public, max-age=60, must-revalidate", etag: image.etag,
      "content-type": image.mime, "content-disposition": "inline" };
    if (request.headers.get("if-none-match") === image.etag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(image.bytes), { headers });
  } catch { return NextResponse.json({ error: "Image unavailable" }, { status: 404, headers: publicMediaHeaders }); }
}
