import { NextResponse } from "next/server";

import { buildWinProbSeries } from "@/server/replay-service";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const seasonParam = searchParams.get("season");
  const matchupId = searchParams.get("matchupId") ?? searchParams.get("matchup_id");
  const scenario = searchParams.get("scenario") ?? undefined; // reserved for future use
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  if (!seasonParam || !matchupId) {
    return NextResponse.json({ error: "Missing required query parameters: season, matchupId" }, { status: 400 });
  }

  const season = Number(seasonParam);
  if (!Number.isFinite(season)) {
    return NextResponse.json({ error: "Season must be a number" }, { status: 400 });
  }

  const fromTs = fromParam ? Number(fromParam) : undefined;
  const toTs = toParam ? Number(toParam) : undefined;

  try {
    const result = await buildWinProbSeries(season, String(matchupId), fromTs, toTs);
    if (!result) {
      return NextResponse.json(
        { error: `Matchup ${matchupId} not found for season ${season}` },
        { status: 404 },
      );
    }
    return NextResponse.json(
      {
        season,
        matchupId,
        scenario: scenario ?? null,
        week: result.meta.week,
        homeTeamId: result.meta.homeTeamId,
        awayTeamId: result.meta.awayTeamId,
        series: result.series,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `Unable to build win probability series: ${message}` }, { status: 500 });
  }
}


