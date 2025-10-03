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
        <p className="text-sm text-[var(--text-muted)]">Regular season complete.</p>
      </>
    );
  }

  const nextStatus = matchup.status ?? (matchup.isActual ? (matchup.result ? "final" : "in_progress") : "upcoming");
  const isLive = nextStatus === "in_progress";
  const isFinal = nextStatus === "final";
  const labelPrefix = isLive ? "Live" : isFinal ? "Final" : "Upcoming";

  const heading = (
    <h3 className="text-[1.05rem] font-semibold text-[var(--text-soft)]">
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
        <p className="text-[0.95rem] text-[var(--text-soft)]">{forPts} – {againstPts}</p>
        <p className="text-sm text-[var(--text-muted)]">{liveDiff ?? ""} • {probabilityLabel(matchup.win_probability)}</p>
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
        <p className="text-[0.95rem] text-[var(--text-soft)]">{forPts} – {againstPts}</p>
        <p className="text-sm text-[var(--text-muted)]">{diff ?? ""}</p>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-[0.95rem] text-[var(--text-soft)]">{matchup.projected_points.toFixed(1)} – {matchup.opponent_projected_points.toFixed(1)}</p>
        <p className="text-sm text-[var(--text-muted)]">{probabilityLabel(matchup.win_probability)} · {formatMargin(matchup.projected_margin)}</p>
      </>
    );
  }

  return (
    <>
      {title ? <span className="text-[0.72rem] uppercase tracking-[0.16em] text-[var(--text-muted)]">{title}</span> : null}
      {heading}
      {body}
      {opponentMetrics ? (
        <>
          <p className="text-sm text-[var(--text-muted)]">
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
            <p className="text-sm text-[var(--text-muted)]">Projected {formatSimpleRecord(opponentStandingProjected)}</p>
          ) : null}
        </>
      ) : null}
    </>
  );
}


