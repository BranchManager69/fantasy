import Link from "next/link";
import {
  formatFinalMargin,
  formatLiveMargin,
  formatMargin,
  probabilityClass,
  probabilityLabel,
} from "@/lib/formatters";
import type {
  TeamScheduleWithContext,
  SimulationPlayer,
} from "@/lib/simulator-data";

interface WeekCellProps {
  entry: TeamScheduleWithContext | undefined;
  week: number;
}

function PlayerList({ players, maxCount = 3 }: { players: SimulationPlayer[]; maxCount?: number }) {
  if (!players || players.length === 0) return null;

  const topPlayers = players
    .filter(p => p.projected_points > 0)
    .sort((a, b) => (b.projected_points || 0) - (a.projected_points || 0))
    .slice(0, maxCount);

  if (topPlayers.length === 0) return null;

  return (
    <div className="week-cell__players">
      {topPlayers.map((player, idx) => (
        <span key={`${player.espn_player_id}-${player.lineup_slot}`} className="week-cell__player">
          <span className="week-cell__player-name">{player.player_name}</span>
          <span className="week-cell__player-points">{player.projected_points.toFixed(1)}</span>
        </span>
      ))}
    </div>
  );
}

export function WeekCell({ entry, week }: WeekCellProps) {
  if (!entry) {
    return (
      <td className="cell cell--empty">
        <div className="week-cell">—</div>
      </td>
    );
  }

  const opponent = entry.opponent;
  const opponentLabel = opponent ? opponent.abbrev || opponent.name : `Team ${entry.opponent_team_id}`;
  const opponentHref = opponent ? `/teams/${opponent.team_id}` : null;
  const direction = entry.is_home ? "vs" : "@";
  const isActual = entry.isActual;
  const status = entry.status ?? (isActual ? (entry.result ? "final" : "in_progress") : "upcoming");
  const isLive = isActual && status === "in_progress";
  const isFinal = isActual && status === "final";

  const cellClass = isActual
    ? `cell cell--actual ${isLive ? "cell--actual-live" : `cell--actual-${entry.result ?? "tie"}`}`
    : probabilityClass(entry.win_probability);

  const pointsFor = isActual ? entry.actualPoints ?? entry.projected_points : entry.projected_points;
  const pointsAgainst = isActual
    ? entry.opponentActualPoints ?? entry.opponent_projected_points
    : entry.opponent_projected_points;

  const actualMargin =
    entry.actualPoints !== null && entry.opponentActualPoints !== null
      ? entry.actualPoints - entry.opponentActualPoints
      : entry.projected_margin;

  const marginCopy = isActual
    ? isLive
      ? formatLiveMargin(entry.actualPoints, entry.opponentActualPoints)
      : formatFinalMargin(actualMargin)
    : formatMargin(entry.projected_margin);

  const winPct = Math.round(entry.win_probability * 100);

  const resultLabel = isLive
    ? "Live"
    : entry.result === "win"
      ? "Won"
      : entry.result === "loss"
        ? "Lost"
        : entry.result === "tie"
          ? "Tied"
          : "Final";

  const teamStarters = entry.teamProjection?.starters || [];
  const opponentStarters = entry.opponentProjection?.starters || [];

  return (
    <td className={cellClass}>
      <div className="week-cell">
        <div className="week-cell__header">
          <div className="week-cell__score">{pointsFor.toFixed(1)}</div>
          <div className="week-cell__opponent">
            <span className="week-cell__direction">{direction}</span>
            {opponentHref ? (
              <Link href={opponentHref} className="week-cell__opponent-name">
                {opponentLabel}
              </Link>
            ) : (
              <span className="week-cell__opponent-name">{opponentLabel}</span>
            )}
            <span className="week-cell__opponent-score">{pointsAgainst.toFixed(1)}</span>
          </div>
        </div>

        <div className="week-cell__details">
          <div className="week-cell__margin">{marginCopy}</div>

          {isActual ? (
            <div className={`week-cell__result ${isLive ? "week-cell__result--live" : "week-cell__result--final"}`}>
              <span className="week-cell__result-label">{resultLabel}</span>
              {isLive && (
                <span className="week-cell__probability">{probabilityLabel(entry.win_probability)}</span>
              )}
            </div>
          ) : (
            <div className="week-cell__projection">
              <span className="week-cell__probability">{probabilityLabel(entry.win_probability)}</span>
              <div className="week-cell__prob-bar">
                <span style={{ width: `${winPct}%` }} />
              </div>
            </div>
          )}
        </div>

        {(teamStarters.length > 0 || opponentStarters.length > 0) && (
          <div className="week-cell__lineups">
            {teamStarters.length > 0 && (
              <div className="week-cell__team-lineup">
                <span className="week-cell__lineup-label">Top</span>
                <PlayerList players={teamStarters} maxCount={2} />
              </div>
            )}
            {opponentStarters.length > 0 && (
              <div className="week-cell__opponent-lineup">
                <span className="week-cell__lineup-label">vs</span>
                <PlayerList players={opponentStarters} maxCount={2} />
              </div>
            )}
          </div>
        )}

        {entry.opponentStanding && (
          <div className="week-cell__context">
            <span className="week-cell__opponent-record">
              {entry.opponentStanding.projected_record.wins}-{entry.opponentStanding.projected_record.losses}
              {entry.opponentStanding.projected_record.ties > 0 && `-${entry.opponentStanding.projected_record.ties}`}
            </span>
            {entry.opponentMonteCarlo?.playoff_odds && entry.opponentMonteCarlo.playoff_odds > 0.05 && (
              <span className="week-cell__opponent-odds">
                {Math.round(entry.opponentMonteCarlo.playoff_odds * 100)}%
              </span>
            )}
          </div>
        )}
      </div>
    </td>
  );
}