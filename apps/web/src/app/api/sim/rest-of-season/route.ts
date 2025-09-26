import { NextRequest, NextResponse } from "next/server";

import { getLatestSimulation, loadSimulation } from "@/lib/simulator-data";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const seasonParam = params.get("season");

  if (seasonParam) {
    const season = Number(seasonParam);
    if (!Number.isFinite(season)) {
      return NextResponse.json(
        { error: "Invalid season parameter." },
        { status: 400 },
      );
    }

    const dataset = await loadSimulation(season);
    if (!dataset) {
      return NextResponse.json(
        { error: `No simulation dataset found for season ${season}.` },
        { status: 404 },
      );
    }
    return NextResponse.json(dataset, { headers: { "cache-control": "no-store" } });
  }

  const latest = await getLatestSimulation();
  if (!latest) {
    return NextResponse.json(
      {
        error: "Simulation dataset not generated yet. Run 'poetry run fantasy sim rest-of-season'.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(latest, { headers: { "cache-control": "no-store" } });
}
