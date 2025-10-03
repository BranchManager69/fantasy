import Link from "next/link";

import { OwnerAvatars } from "@/components/owner-avatars";
import { WeekCell } from "@/components/week-cell";
import type { SimulationTeamContext } from "@/components/simulation/types";
import { formatOwners } from "@/lib/formatters";
import type { TeamScheduleWithContext } from "@/lib/simulator-data";
import { formatSimpleRecord } from "@/lib/team-metrics";

function WeekHeader({ weeks }: { weeks: number[] }) {
  return (
    <thead>
      <tr>
        <th scope="col">Team Outlook</th>
        {weeks.map((week) => (
          <th key={week} scope="col">
            Week {week}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function TeamRow({ context, weeks }: { context: SimulationTeamContext; weeks: number[] }) {
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

  return (
    <tr>
      <th scope="row">
        <div className="team-heading">
          <Link href={`/teams/${team.team_id}`} className="team-heading__name" title={team.name}>
            {team.name}
          </Link>
          <span className="team-heading__owners" title={formatOwners(team.owners)}>
            <OwnerAvatars teamId={team.team_id} ownersCount={team.owners.length} /> {formatOwners(team.owners)}
          </span>
          <div className="team-heading__meta">
            <span className="team-heading__record">{formatSimpleRecord(record)}</span>
            {avgWinsCopy ? (
              <span className="team-heading__avg" title="Expected wins vs projected record (Monte Carlo)">{avgWinsCopy}</span>
            ) : null}
            {playoffCopy ? <span className="team-heading__prob">{playoffCopy}</span> : null}
            {seedCopy ? <span className="team-heading__seed">{seedCopy}</span> : null}
          </div>
        </div>
      </th>
      {weeks.map((week) => {
        const entry = weeklyMap.get(week);
        return <WeekCell key={week} entry={entry} week={week} />;
      })}
    </tr>
  );
}

export function SimulationMatrix({ weeks, teamContexts }: { weeks: number[]; teamContexts: SimulationTeamContext[] }) {
  return (
    <div className="matrix-wrapper">
      <table className="sim-matrix">
        <WeekHeader weeks={weeks} />
        <tbody>
          {teamContexts.map((context) => (
            <TeamRow key={context.team.team_id} context={context} weeks={weeks} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
