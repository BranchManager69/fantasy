import { existsSync } from "node:fs";
import path from "node:path";

import clsx from "clsx";
import Link from "next/link";
import { WeekCell } from "@/components/week-cell";
import type { SimulationTeamContext } from "@/components/simulation/types";
import { formatOwners } from "@/lib/formatters";
import type { TeamScheduleWithContext } from "@/lib/simulator-data";
import { formatSimpleRecord } from "@/lib/team-metrics";

const HEADER_CELL =
  "sticky top-0 z-30 bg-[rgba(13,23,44,0.95)] backdrop-blur-xl text-left text-sm font-semibold text-[var(--text-muted)] border-b border-[var(--border)] px-5 py-3";

const PUBLIC_DIR = path.join(process.cwd(), "public");

function resolveTeamBackground(teamId: number, logoUrl: string | null) {
  const candidates = [
    `/owners/${teamId}-1.png`,
    `/owners/${teamId}.png`,
    logoUrl,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.startsWith("http")) {
      if (candidate === logoUrl) {
        return candidate;
      }
      continue;
    }
    const filePath = path.join(PUBLIC_DIR, candidate);
    if (existsSync(filePath)) {
      return candidate;
    }
  }

  return null;
}

function WeekHeader({ weeks }: { weeks: number[] }) {
  return (
    <thead>
      <tr>
        <th
          scope="col"
          className={clsx(
            HEADER_CELL,
            "rounded-tl-[var(--radius-md)] text-[var(--text-soft)]",
          )}
          style={{ minWidth: 240, width: 240 }}
        >
          Team Outlook
        </th>
        {weeks.map((week, index) => (
          <th
            key={week}
            scope="col"
            className={clsx(
              HEADER_CELL,
              index === weeks.length - 1 && "rounded-tr-[var(--radius-md)]",
            )}
            style={{ minWidth: 220, width: 220 }}
          >
            Week {week}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function TeamRow({ context, weeks, scenarioId }: { context: SimulationTeamContext; weeks: number[]; scenarioId?: string }) {
  const { team, standing, schedule, monteCarlo } = context;
  const record = standing?.projected_record ?? { wins: 0, losses: 0, ties: 0 };
  const weeklyMap = new Map<number, TeamScheduleWithContext>(schedule.map((entry) => [entry.week, entry] as const));

  const mc = monteCarlo ?? null;
  const playoffCopy = mc ? `${Math.round(mc.playoff_odds * 100)}% playoff odds` : null;
  const seedCopy = mc && mc.top_seed_odds > 0.01 ? `${Math.round(mc.top_seed_odds * 100)}% for #1 seed` : null;
  const projectedWins = record?.wins ?? null;
  const winsDeltaRaw = mc && projectedWins !== null ? mc.average_wins - projectedWins : null;
  const avgWinsCopy = winsDeltaRaw !== null && Math.abs(winsDeltaRaw) >= 0.3
    ? `${winsDeltaRaw >= 0 ? "+" : ""}${winsDeltaRaw.toFixed(1)}W`
    : null;
  const logoUrl = team.logo_url ?? null;
  const backgroundImage = resolveTeamBackground(team.team_id, logoUrl);

  return (
    <tr>
      <th
        scope="row"
        className="sticky left-0 z-20 border-r border-[var(--border)] bg-transparent p-0 align-top"
        style={{ minWidth: 240, width: 240 }}
      >
        <div
          className="relative h-full overflow-hidden rounded-r-[var(--radius-sm)]"
          style={{
            backgroundImage: backgroundImage
              ? `linear-gradient(90deg, rgba(15,24,45,0.95) 0%, rgba(15,24,45,0.85) 55%, rgba(15,24,45,0.6) 100%), url(${backgroundImage})`
              : `linear-gradient(90deg, rgba(15,24,45,0.95) 0%, rgba(15,24,45,0.85) 55%, rgba(15,24,45,0.6) 100%)`,
            backgroundColor: "rgba(15,24,45,0.94)",
            backgroundSize: backgroundImage ? "100% 100%, cover" : "auto",
            backgroundPosition: backgroundImage ? "center, center right" : "center",
            backgroundRepeat: "no-repeat",
          }}
        >
          <div className="relative flex h-full flex-col gap-2 p-4 backdrop-blur-[2px]">
            <Link
              href={`/teams/${team.team_id}`}
              className="flex items-center gap-2 text-[var(--text-primary)]"
              title={team.name}
            >
              <span className="rounded-md bg-[rgba(96,165,250,0.2)] px-2 py-0.5 text-xs uppercase tracking-[0.16em] text-[var(--accent)] backdrop-blur">
                {team.abbrev ?? team.name.slice(0, 3).toUpperCase()}
              </span>
              <span className="truncate text-base font-semibold">{team.name}</span>
            </Link>
            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.14em] text-[var(--text-muted)]">
              <span className="text-[var(--accent)]">{formatSimpleRecord(record)}</span>
              <span className="truncate" title={formatOwners(team.owners)}>{formatOwners(team.owners)}</span>
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-[var(--text-muted)]">
              {avgWinsCopy ? (
                <span title="Expected wins vs projected record (Monte Carlo)">{avgWinsCopy}</span>
              ) : null}
              {playoffCopy ? <span className="text-[var(--accent-strong)]">{playoffCopy}</span> : null}
              {seedCopy ? <span className="text-[var(--accent)]">{seedCopy}</span> : null}
            </div>
          </div>
        </div>
      </th>
      {weeks.map((week) => {
        const entry = weeklyMap.get(week);
        return <WeekCell key={week} entry={entry} week={week} scenarioId={scenarioId} />;
      })}
    </tr>
  );
}

export function SimulationMatrix({ weeks, teamContexts, scenarioId }: { weeks: number[]; teamContexts: SimulationTeamContext[]; scenarioId?: string }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
      <table className="w-full border-separate border-spacing-0 bg-[rgba(13,23,44,0.82)]">
        <WeekHeader weeks={weeks} />
        <tbody>
          {teamContexts.map((context) => (
            <TeamRow key={context.team.team_id} context={context} weeks={weeks} scenarioId={scenarioId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
