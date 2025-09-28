import { NextResponse } from "next/server";

import { getLatestSimulation } from "@/lib/simulator-data";
import { getJobSnapshot } from "@/server/sim-job";

export async function GET() {
  const latest = await getLatestSimulation();
  const snapshot = getJobSnapshot();

  return NextResponse.json(
    {
      datasetGeneratedAt: latest?.generated_at ?? null,
      job: snapshot,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
