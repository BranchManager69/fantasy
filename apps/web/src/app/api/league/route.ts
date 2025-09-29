import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

import { getEspnOutRoot } from "@/lib/paths";

type TeamRecord = {
  season: string;
  team_id: string;
  team_name: string;
  abbrev?: string;
  division_id?: string;
  owners?: string;
  playoff_seed?: string;
  logo?: string;
};

type LeagueResponse = {
  metadata: {
    season: number;
    generated_at: string;
    source: string;
  };
  items: Array<{
    team_id: number;
    slug: string;
    name: string;
    abbrev: string | null;
    division_id: number | null;
    owners: string[];
    playoff_seed: number | null;
    logo_url: string | null;
  }>;
};

function sanitizeSlug(id: number, name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
  return `team-${id}${safe ? `-${safe}` : ""}`;
}

function normalizeTeam(record: TeamRecord) {
  const teamId = Number(record.team_id);
  const owners = (record.owners || "")
    .split(";")
    .map((owner) => owner.trim())
    .filter(Boolean);
  const divisionId = record.division_id ? Number(record.division_id) : null;
  const playoffSeed = record.playoff_seed ? Number(record.playoff_seed) : null;

  return {
    team_id: teamId,
    slug: sanitizeSlug(teamId, record.team_name),
    name: record.team_name,
    abbrev: record.abbrev || null,
    division_id: Number.isFinite(divisionId) ? divisionId : null,
    owners,
    playoff_seed: Number.isFinite(playoffSeed) ? playoffSeed : null,
    logo_url: record.logo || null,
  };
}

export async function GET() {
  try {
    const espnRoot = getEspnOutRoot();
    const espnDirEntries = await fs.readdir(espnRoot, { withFileTypes: true });
    const seasons = espnDirEntries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(b) - Number(a));

    if (seasons.length === 0) {
      return NextResponse.json(
        {
          error: "No season outputs available. Run 'poetry run fantasy espn normalize' first.",
        },
        { status: 503 },
      );
    }

    const season = seasons[0];
    const teamsPath = path.join(espnRoot, season, "teams.csv");

    try {
      await fs.access(teamsPath);
    } catch {
      return NextResponse.json(
        {
          error: `Missing teams.csv for season ${season}. Run 'poetry run fantasy espn normalize'.`,
        },
        { status: 503 },
      );
    }

    const rawCsv = await fs.readFile(teamsPath, "utf-8");
    const records = parse(rawCsv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as TeamRecord[];

    const stats = await fs.stat(teamsPath);

    const payload: LeagueResponse = {
      metadata: {
        season: Number(season),
        generated_at: stats.mtime.toISOString(),
        source: "espn_normalize_v1",
      },
      items: records.map(normalizeTeam),
    };

    return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("/api/league failure", error);
    return NextResponse.json(
      {
        error: "Failed to load league metadata.",
      },
      { status: 500 },
    );
  }
}
