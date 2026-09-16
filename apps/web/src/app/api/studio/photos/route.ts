import { NextResponse } from "next/server";
import { sameOrigin, studioAuthorized, studioHeaders } from "@/server/league-studio-auth";
import { PhotoLibraryError, studioPhotos } from "@/server/league-studio-photos";
import { photoError } from "@/server/league-studio-photo-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!await studioAuthorized(request)) return NextResponse.json({ error: "Sign in to view your photos" }, { status: 401, headers: studioHeaders });
  try { return NextResponse.json({ photos: await studioPhotos.list() }, { headers: studioHeaders }); }
  catch (error) { return photoError(error); }
}
export async function POST(request: Request) {
  if (!sameOrigin(request) || !await studioAuthorized(request)) return NextResponse.json({ error: "Sign in to add photos" }, { status: 401, headers: studioHeaders });
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new PhotoLibraryError("Choose an image");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 11 * 1024 * 1024) throw new PhotoLibraryError("Images must be at most 10 MB", 413);
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type") || "" } }).formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw new PhotoLibraryError("Choose an image");
    const bytes = Buffer.from(await file.arrayBuffer());
    const action = form.get("action");
    if (action === "source") {
      const metadata = form.get("metadata");
      if (typeof metadata !== "string" || Buffer.byteLength(metadata, "utf8") > 256 * 1024) throw new PhotoLibraryError("Supply photo details within 256 KB");
      return NextResponse.json({ photo: await studioPhotos.importSource(JSON.parse(metadata), bytes) }, { headers: studioHeaders });
    }
    if (action === "cutout") {
      const photoId = form.get("photoId");
      const members = form.get("memberIds");
      if (typeof photoId !== "string" || typeof members !== "string" || members.length > 2000) throw new PhotoLibraryError("Choose the source photo and cutout members");
      return NextResponse.json({ photo: await studioPhotos.addCutout(photoId, file.name, JSON.parse(members), bytes) }, { headers: studioHeaders });
    }
    throw new PhotoLibraryError("Choose a source photo or cutout upload");
  } catch (error) { return photoError(error); }
}
