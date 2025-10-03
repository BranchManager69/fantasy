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
    <section className="power-rankings">
      <header className="power-rankings__header">
        <h2>Power Rankings</h2>
        <p className="power-rankings__subtitle">Rest-of-season projected PPG</p>
      </header>
      <div className="power-rankings__list">
        {rankings.map((entry) => (
          <Link
            key={entry.team.team_id}
            href={`/teams/${entry.team.team_id}`}
            className="power-rankings__item"
          >
            <span className="power-rankings__rank">#{entry.rank}</span>
            <div className="power-rankings__team">
              <OwnerAvatars
                teamId={entry.team.team_id}
                ownersCount={entry.team.owners.length}
                size={32}
                className="power-rankings__avatars"
              />
              <div className="power-rankings__info">
                <span className="power-rankings__name">{entry.team.name}</span>
                <span className="power-rankings__owners" title={formatOwners(entry.team.owners)}>
                  {formatOwners(entry.team.owners)}
                </span>
              </div>
            </div>
            <span className="power-rankings__ppg">{entry.projectedPPG.toFixed(1)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
