import Link from "next/link";
import { OwnerAvatars } from "./owner-avatars";
import { formatOwners } from "@/lib/formatters";
import type { SimulationTeamMeta } from "@/lib/simulator-data";

export type PowerRankingEntry = {
  rank: number;
  team: SimulationTeamMeta;
  projectedPPG: number;
};

type Props = {
  rankings: PowerRankingEntry[];
};

export function PowerRankings({ rankings }: Props) {
  return (
    <section className="grid gap-6 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[rgba(14,21,39,0.72)] p-8 backdrop-blur-lg">
      <header className="flex flex-col gap-2 border-b border-[var(--border-subtle)] pb-4">
        <h2 className="text-2xl font-semibold text-[var(--text-primary)]">Power Rankings</h2>
        <p className="text-sm text-[var(--text-muted)]">Rest-of-season projected PPG</p>
      </header>
      <div className="grid gap-2">
        {rankings.map((entry) => (
          <Link
            key={entry.team.team_id}
            href={`/teams/${entry.team.team_id}`}
            className="grid grid-cols-[44px,1fr,auto] items-center gap-4 rounded-[var(--radius-md)] border border-[rgba(148,163,184,0.15)] bg-[rgba(15,23,42,0.5)] px-5 py-4 text-[var(--text-soft)] transition duration-200 hover:-translate-x-1 hover:border-[rgba(96,165,250,0.4)] hover:bg-[rgba(20,30,55,0.72)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.2)]"
          >
            <span className="text-lg font-semibold text-[var(--accent)] tabular-nums">#{entry.rank}</span>
            <div className="flex items-center gap-4 min-w-0">
              <OwnerAvatars
                teamId={entry.team.team_id}
                ownersCount={entry.team.owners.length}
                size={32}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-base font-semibold text-[var(--text-primary)]">{entry.team.name}</span>
                <span className="truncate text-xs uppercase tracking-[0.14em] text-[var(--text-muted)]" title={formatOwners(entry.team.owners)}>
                  {formatOwners(entry.team.owners)}
                </span>
              </div>
            </div>
            <span className="text-xl font-bold text-[var(--accent-strong)] tabular-nums">{entry.projectedPPG.toFixed(1)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
