import Link from "next/link";

import { betterRecord, formatSimpleRecord } from "@/lib/team-metrics";

import type { HighlightCard, SimulationTeamContext } from "./types";

function formatPointDifferential(value: number): string {
  const rounded = value.toFixed(1);
  return value >= 0 ? `+${rounded}` : rounded;
}

function describeUpcoming(scheduleLeader: SimulationTeamContext | null): string | null {
  if (!scheduleLeader) return null;
  const upcomingGames = scheduleLeader.schedule.filter((entry) => !entry.isActual);
  if (upcomingGames.length === 0) {
    return null;
  }

  const preview = upcomingGames.slice(0, 3).map((entry) => {
    const opponentLabel = entry.opponent?.abbrev || entry.opponent?.name || `Team ${entry.opponent_team_id}`;
    const projectedRecord = entry.opponentStanding?.projected_record;
    const recordCopy = projectedRecord ? formatSimpleRecord(projectedRecord) : null;
    const playoffOdds = entry.opponentMonteCarlo?.playoff_odds;
    const oddsCopy = typeof playoffOdds === "number" && Number.isFinite(playoffOdds)
      ? `${Math.round(playoffOdds * 100)}%`
      : null;

    if (recordCopy && oddsCopy) return `${opponentLabel} ${recordCopy} (${oddsCopy})`;
    if (recordCopy) return `${opponentLabel} ${recordCopy}`;
    if (oddsCopy) return `${opponentLabel} ${oddsCopy}`;
    return opponentLabel;
  });

  if (preview.length === 0) {
    return null;
  }

  const remainingCount = upcomingGames.length - preview.length;
  const joined = preview.join(", ");
  return remainingCount > 0 ? `Remaining: ${joined}, +${remainingCount} more` : `Remaining: ${joined}`;
}

export function buildHighlightCards(teamContexts: SimulationTeamContext[]): HighlightCard[] {
  if (teamContexts.length === 0) {
    return [];
  }

  const recordLeader = teamContexts.reduce((best, current) =>
    betterRecord(current.metrics, best.metrics) ? current : best,
    teamContexts[0],
  );

  const scoringLeader = teamContexts.reduce((best, current) => {
    const currentPpg = current.metrics.pointsPerGame ?? 0;
    const bestPpg = best.metrics.pointsPerGame ?? 0;
    if (currentPpg !== bestPpg) {
      return currentPpg > bestPpg ? current : best;
    }
    return current.metrics.pointsFor > best.metrics.pointsFor ? current : best;
  }, teamContexts[0]);

  const diffLeader = teamContexts.reduce((best, current) =>
    current.metrics.pointDifferential > best.metrics.pointDifferential ? current : best,
    teamContexts[0],
  );

  const contextsWithUpcoming = teamContexts.filter((context) => context.metrics.upcomingAvgWins !== null);
  const scheduleLeader = contextsWithUpcoming.length
    ? contextsWithUpcoming.reduce((best, current) => {
        const bestVal = best.metrics.upcomingAvgWins ?? -Infinity;
        const currentVal = current.metrics.upcomingAvgWins ?? -Infinity;
        if (currentVal !== bestVal) {
          return currentVal > bestVal ? current : best;
        }
        const bestOdds = best.metrics.upcomingAvgPlayoffOdds ?? -Infinity;
        const currentOdds = current.metrics.upcomingAvgPlayoffOdds ?? -Infinity;
        return currentOdds > bestOdds ? current : best;
      })
    : null;

  const cards: HighlightCard[] = [];

  const recordProjected = recordLeader.standing?.projected_record;
  cards.push({
    id: "top-seed",
    eyebrow: "Top seed pace",
    heading: recordLeader.team.name,
    link: `/teams/${recordLeader.team.team_id}`,
    value: formatSimpleRecord({
      wins: recordLeader.metrics.wins,
      losses: recordLeader.metrics.losses,
      ties: recordLeader.metrics.ties,
    }),
    meta: recordProjected ? `Projected ${formatSimpleRecord(recordProjected)}` : null,
    secondary:
      recordLeader.metrics.pointDifferential !== 0
        ? `Diff ${formatPointDifferential(recordLeader.metrics.pointDifferential)}`
        : null,
  });

  const scoringValue = scoringLeader.metrics.pointsPerGame;
  cards.push({
    id: "scoring-leader",
    eyebrow: "Scoring leader",
    heading: scoringLeader.team.name,
    link: `/teams/${scoringLeader.team.team_id}`,
    value: scoringValue !== null ? `${scoringValue.toFixed(1)} PPG` : `${scoringLeader.metrics.pointsFor.toFixed(1)} PF`,
    meta: `Total PF ${scoringLeader.metrics.pointsFor.toFixed(1)}`,
    secondary:
      scoringLeader.metrics.pointsPerGame !== null && scoringLeader.metrics.pointsPerGame > 0
        ? `Games played ${scoringLeader.metrics.wins + scoringLeader.metrics.losses + scoringLeader.metrics.ties}`
        : null,
  });

  cards.push({
    id: "point-diff",
    eyebrow: "Point differential",
    heading: diffLeader.team.name,
    link: `/teams/${diffLeader.team.team_id}`,
    value: formatPointDifferential(diffLeader.metrics.pointDifferential),
    meta: `Points allowed ${diffLeader.metrics.pointsAgainst.toFixed(1)}`,
  });

  if (scheduleLeader) {
    const avgWins = scheduleLeader.metrics.upcomingAvgWins ?? 0;
    const avgPlayoff = scheduleLeader.metrics.upcomingAvgPlayoffOdds ?? null;
    const nextGame = scheduleLeader.metrics.nextGame;
    cards.push({
      id: "tough-schedule",
      eyebrow: "Toughest remaining slate",
      heading: scheduleLeader.team.name,
      link: `/teams/${scheduleLeader.team.team_id}`,
      value: `${avgWins.toFixed(1)} opp avg wins`,
      meta: avgPlayoff !== null ? `Opp playoff odds ${(avgPlayoff * 100).toFixed(0)}%` : null,
      secondary: nextGame
        ? `Next: Week ${nextGame.week} ${nextGame.is_home ? "vs" : "@"} ${nextGame.opponent?.name ?? `Team ${nextGame.opponent_team_id}`}`
        : "No games remaining",
      extra: describeUpcoming(scheduleLeader),
    });
  } else {
    cards.push({
      id: "tough-schedule",
      eyebrow: "Season outlook",
      heading: "Schedule locked",
      value: "—",
      meta: "All remaining games finalized",
    });
  }

  return cards;
}

export function HighlightCards({ cards }: { cards: HighlightCard[] }) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <section className="league-summary">
      {cards.map((card) => (
        <article key={card.id} className="league-summary__card">
          <span className="league-summary__eyebrow">{card.eyebrow}</span>
          {card.link ? (
            <h3>
              <Link href={card.link}>{card.heading}</Link>
            </h3>
          ) : (
            <h3>{card.heading}</h3>
          )}
          <p className="league-summary__value">{card.value}</p>
          {card.meta ? <p className="league-summary__meta">{card.meta}</p> : null}
          {card.secondary ? <p className="league-summary__meta">{card.secondary}</p> : null}
          {card.extra ? <p className="league-summary__meta">{card.extra}</p> : null}
        </article>
      ))}
    </section>
  );
}
