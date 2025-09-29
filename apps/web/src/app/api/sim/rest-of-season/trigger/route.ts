import { NextResponse } from "next/server";

import { simJobRunner } from "@/server/sim-job";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const scenarioParam = url.searchParams.get("scenario");
  const scenarioId = scenarioParam && scenarioParam.trim() ? scenarioParam.trim() : undefined;
  try {
    const snapshot = simJobRunner.start(scenarioId);
    return NextResponse.json(snapshot, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message.includes("already running")) {
      return NextResponse.json(
        { error: "Simulation refresh already running." },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start simulation" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
