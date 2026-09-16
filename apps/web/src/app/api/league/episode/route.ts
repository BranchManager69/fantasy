import { NextResponse } from "next/server";
import { publicLeagueEpisode, publicMediaHeaders, publicMediaSelection } from "@/server/league-public-media";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const selection = publicMediaSelection(new URL(request.url).searchParams);
  if (!selection) return NextResponse.json({ error: "Choose a valid season, week and team" }, { status: 400, headers: publicMediaHeaders });
  try { return NextResponse.json(await publicLeagueEpisode(selection), { headers: publicMediaHeaders }); }
  catch { return NextResponse.json({ error: "League images are temporarily unavailable" }, { status: 503, headers: publicMediaHeaders }); }
}
