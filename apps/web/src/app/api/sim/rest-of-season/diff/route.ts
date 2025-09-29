import { NextResponse } from "next/server";

import { readDiffEntries } from "@/server/diff-service";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const includeEmptyParam = url.searchParams.get("includeEmpty");

  let limit = Number.parseInt(limitParam ?? "10", 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    limit = 10;
  } else if (limit > 50) {
    limit = 50;
  }

  const includeEmpties = includeEmptyParam === "true";

  const items = await readDiffEntries(limit, { includeEmpties });

  return NextResponse.json(
    { items },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
