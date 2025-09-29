import { NextResponse } from "next/server";

import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";
import { getMatchupDetail } from "@/server/matchup-service";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const seasonParam = searchParams.get("season");
  const matchupId = searchParams.get("matchupId") ?? searchParams.get("matchup_id");
  const scenarioParam = searchParams.get("scenario");

  if (!seasonParam || !matchupId) {
    return NextResponse.json({ error: "Missing required query parameters: season, matchupId" }, { status: 400 });
  }

  const season = Number(seasonParam);
  if (!Number.isFinite(season)) {
    return NextResponse.json({ error: "Season must be a number" }, { status: 400 });
  }

  const scenarioId = scenarioParam && scenarioParam.trim() ? scenarioParam.trim() : BASELINE_SCENARIO_ID;

  try {
    const detail = await getMatchupDetail(season, matchupId, scenarioId);
    if (!detail) {
      return NextResponse.json({ error: `Matchup ${matchupId} not found for season ${season}` }, { status: 404 });
    }
    return NextResponse.json(detail, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `Unable to load matchup detail: ${message}` }, { status: 500 });
  }
}
