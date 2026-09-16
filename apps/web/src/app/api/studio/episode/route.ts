import { NextResponse } from "next/server";
import { studioAuthorized, studioHeaders } from "@/server/league-studio-auth";
import { savedStudioEpisode } from "@/server/league-studio-episode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!await studioAuthorized(request)) return NextResponse.json({ error: "Sign in to view saved episodes" }, { status: 401, headers: studioHeaders });
  const search = new URL(request.url).searchParams;
  const values = ["season", "week", "teamId"].map((key) => search.get(key));
  if (values.some((value) => !value || !/^\d{1,7}$/.test(value))) {
    return NextResponse.json({ error: "Choose a valid season, week and team" }, { status: 400, headers: studioHeaders });
  }
  const [season, week, teamId] = values.map(Number);
  if (season < 2000 || season > 2100 || week < 1 || week > 18 || teamId < 1 || teamId > 1_000_000) {
    return NextResponse.json({ error: "Choose a valid season, week and team" }, { status: 400, headers: studioHeaders });
  }
  try { return NextResponse.json(await savedStudioEpisode({ season, week, teamId }), { headers: studioHeaders }); }
  catch { return NextResponse.json({ error: "Saved episodes are temporarily unavailable" }, { status: 503, headers: studioHeaders }); }
}
