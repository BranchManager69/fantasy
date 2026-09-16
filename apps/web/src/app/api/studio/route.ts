import { NextResponse } from "next/server";
import { studioAuthorized, sameOrigin, studioHeaders } from "@/server/league-studio-auth";
import { readRequestJson } from "@/server/league-studio-core";
import { studioStore, studioSnapshot, analyzeStudioImport, createStudioBoard, renderStudioBoardScene, updateStudioScene, resumeStudioDraft } from "@/server/league-studio-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;
export async function GET(request: Request) {
  if (!await studioAuthorized(request)) return NextResponse.json({ error: "Open the private studio with your access link" }, { status: 401, headers: studioHeaders });
  try { return NextResponse.json(await studioSnapshot(), { headers: studioHeaders }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "The studio is unavailable" }, { status: 503, headers: studioHeaders }); }
}
export async function POST(request: Request) {
  if (!sameOrigin(request) || !await studioAuthorized(request)) return NextResponse.json({ error: "Sign in to the private studio" }, { status: 401, headers: studioHeaders });
  try {
    const body = await readRequestJson(request, 31 * 1024 * 1024);
    switch (body.action) {
      case "profile": return NextResponse.json({ profile: await studioStore.saveProfile(body.profile) }, { headers: studioHeaders });
      case "import": {
        if (body.kind !== "background" && body.kind !== "group_chat") throw new Error("Choose background or group chat");
        if (typeof body.label !== "string" || typeof body.text !== "string") throw new Error("Supply a label and source text");
        return NextResponse.json(await studioStore.importSource({ label: body.label, text: body.text, kind: body.kind }), { headers: studioHeaders });
      }
      case "memory": {
        if (typeof body.id !== "string" || typeof body.enabled !== "boolean" || (body.text !== undefined && typeof body.text !== "string")) throw new Error("Invalid memory edit");
        return NextResponse.json({ memory: await studioStore.updateMemory(body.id, { enabled: body.enabled, ...(body.text !== undefined ? { text: body.text } : {}) }) }, { headers: studioHeaders });
      }
      case "analyze": return NextResponse.json({ job: await analyzeStudioImport(String(body.importId || "")) }, { status: 202, headers: studioHeaders });
      case "resume": return NextResponse.json({ job: await resumeStudioDraft(String(body.jobId || "")) }, { status: 202, headers: studioHeaders });
      case "storyboard": {
        if (![body.season, body.week, body.teamId].every(Number.isInteger) || (body.direction !== undefined && (typeof body.direction !== "string" || body.direction.length > 2000))) throw new Error("Choose a season, week and team, with an optional direction up to 2,000 characters");
        return NextResponse.json({ job: await createStudioBoard({ season: Number(body.season), week: Number(body.week), teamId: Number(body.teamId), direction: body.direction as string | undefined }) }, { status: 202, headers: studioHeaders });
      }
      case "render": return NextResponse.json({ job: await renderStudioBoardScene(String(body.boardId || ""), String(body.sceneId || "")) }, { status: 202, headers: studioHeaders });
      case "scene": return NextResponse.json({ board: await updateStudioScene(String(body.boardId || ""), String(body.sceneId || ""), { commentary: body.commentary, imageBrief: body.imageBrief }) }, { headers: studioHeaders });
      default: throw new Error("Unknown studio action");
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The studio could not complete that action" }, { status: 400, headers: studioHeaders });
  }
}
