import Link from "next/link";

import { formatMargin, probabilityLabel } from "@/lib/formatters";
import { formatSimpleRecord } from "@/lib/team-metrics";
import type { TeamScheduleWithContext } from "@/lib/simulator-data";

type Props = {
  title?: string;
  matchup: TeamScheduleWithContext | null;
  opponentMetrics?: {
    wins: number;
    losses: number;
    ties: number;
    pointsPerGame: number | null;
    pointsFor: number;
  } | null;
  opponentStandingProjected?: { wins: number; losses: number; ties: number } | null;
};

export function MatchupCard({ title, matchup, opponentMetrics, opponentStandingProjected }: Props) {
  if (!matchup) {
    return (
      <>
        <h3>No games remaining</h3>
        <p className="team-summary__meta">Regular season complete.</p>
      </>
    );
  }

  const nextStatus = matchup.status ?? (matchup.isActual ? (matchup.result ? "final" : "in_progress") : "upcoming");
  const isLive = nextStatus === "in_progress";
  const isFinal = nextStatus === "final";
  const labelPrefix = isLive ? "Live" : isFinal ? "Final" : "Upcoming";

  const heading = (
    <h3>
      Week {matchup.week} • {labelPrefix} {matchup.is_home ? "vs" : "@"}{" "}
      {matchup.opponent ? (
        <Link href={`/teams/${matchup.opponent.team_id}`}>{matchup.opponent.name}</Link>
      ) : (
        `Team ${matchup.opponent_team_id}`
      )}
    </h3>
  );

  let body: React.ReactNode;
  if (isLive) {
    const forPts = (matchup.actualPoints ?? matchup.projected_points).toFixed(1);
    const againstPts = (matchup.opponentActualPoints ?? matchup.opponent_projected_points).toFixed(1);
    const liveDiff = (() => {
      const f = matchup.actualPoints ?? null;
      const a = matchup.opponentActualPoints ?? null;
      if (f === null || a === null) return null;
      const d = f - a;
      if (Math.abs(d) < 0.25) return "Currently tied";
      return d > 0 ? `Leading by ${d.toFixed(1)}` : `Trailing by ${Math.abs(d).toFixed(1)}`;
    })();
    body = (
      <>
        <p>{forPts} – {againstPts}</p>
        <p className="team-summary__meta">{liveDiff ?? ""} • {probabilityLabel(matchup.win_probability)}</p>
      </>
    );
  } else if (isFinal) {
    const forPts = (matchup.actualPoints ?? matchup.projected_points).toFixed(1);
    const againstPts = (matchup.opponentActualPoints ?? matchup.opponent_projected_points).toFixed(1);
    const diff = (() => {
      const f = matchup.actualPoints ?? null;
      const a = matchup.opponentActualPoints ?? null;
      if (f === null || a === null) return null;
      const d = f - a;
      if (Math.abs(d) < 0.25) return "Tied";
      return d > 0 ? `Won by ${d.toFixed(1)}` : `Lost by ${Math.abs(d).toFixed(1)}`;
    })();
    body = (
      <>
        <p>{forPts} – {againstPts}</p>
        <p className="team-summary__meta">{diff ?? ""}</p>
      </>
    );
  } else {
    body = (
      <>
        <p>{matchup.projected_points.toFixed(1)} – {matchup.opponent_projected_points.toFixed(1)}</p>
        <p className="team-summary__meta">{probabilityLabel(matchup.win_probability)} · {formatMargin(matchup.projected_margin)}</p>
      </>
    );
  }

  return (
    <>
      {title ? <span className="team-summary__eyebrow">{title}</span> : null}
      {heading}
      {body}
      {opponentMetrics ? (
        <>
          <p className="team-summary__meta">
            Opponent record {formatSimpleRecord({
              wins: opponentMetrics.wins,
              losses: opponentMetrics.losses,
              ties: opponentMetrics.ties,
            })}
            {opponentMetrics.pointsPerGame !== null
              ? ` · ${opponentMetrics.pointsPerGame.toFixed(1)} PPG`
              : ` · ${opponentMetrics.pointsFor.toFixed(1)} PF`}
          </p>
          {opponentStandingProjected ? (
            <p className="team-summary__meta">Projected {formatSimpleRecord(opponentStandingProjected)}</p>
          ) : null}
        </>
      ) : null}
    </>
  );
}



