import { NextResponse } from "next/server";

import { getScenarioDetail } from "@/server/scenario-service";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const seasonParam = searchParams.get("season");
  const scenarioId = searchParams.get("id");

  if (!seasonParam || !scenarioId) {
    return NextResponse.json({ error: "Missing required query parameters: season, id" }, { status: 400 });
  }

  const season = Number(seasonParam);
  if (!Number.isFinite(season)) {
    return NextResponse.json({ error: "Season must be a number" }, { status: 400 });
  }

  try {
    const detail = await getScenarioDetail(season, scenarioId);
    if (!detail) {
      return NextResponse.json({ error: `Scenario ${scenarioId} not found for season ${season}` }, { status: 404 });
    }
    return NextResponse.json(detail, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `Unable to load scenario: ${message}` }, { status: 500 });
  }
}
