import { NextResponse } from "next/server";

import { getLatestSimulation } from "@/lib/simulator-data";
import { getJobSnapshot } from "@/server/sim-job";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const scenarioParam = url.searchParams.get("scenario");
  const scenarioId = scenarioParam && scenarioParam.trim() ? scenarioParam.trim() : undefined;

  const latest = await getLatestSimulation(scenarioId);
  const snapshot = getJobSnapshot();

  return NextResponse.json(
    {
      datasetGeneratedAt: latest?.generated_at ?? null,
      job: snapshot,
      scenario: latest?.scenario ?? null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
