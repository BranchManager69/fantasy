import { NextResponse } from "next/server";

import { getScenarioList } from "@/server/scenario-service";
import type { ScenarioListResponse } from "@/types/scenario";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const seasonParam = searchParams.get("season");

  if (!seasonParam) {
    return NextResponse.json({ error: "Missing required query parameter: season" }, { status: 400 });
  }

  const season = Number(seasonParam);
  if (!Number.isFinite(season)) {
    return NextResponse.json({ error: "Season must be a number" }, { status: 400 });
  }

  try {
    const items = await getScenarioList(season);
    const payload: ScenarioListResponse = { season, items };
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `Unable to list scenarios: ${message}` }, { status: 500 });
  }
}
