import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  formatFinalMargin,
  formatMargin,
  formatOwners,
  formatRecord,
  probabilityLabel,
  probabilityTone,
} from "@/lib/formatters";
import {
  buildSimulationLookup,
  getLatestSimulation,
  getTeamContext,
} from "@/lib/simulator-data";

function formatPercent(value: number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return `${Math.round(value * 100)}%`;
}

function formatSeed(seed: number | null | undefined): string | null {
  if (seed === null || seed === undefined) {
    return null;
  }
  const suffix = seed === 1 ? "st" : seed === 2 ? "nd" : seed === 3 ? "rd" : "th";
  return `Best seed: #${seed}${suffix}`;
}

type TeamPageProps = {
  params: Promise<{ teamId: string }>;
};

export default async function TeamPage({ params }: TeamPageProps) {
  const { teamId: teamIdParam } = await params;
  const teamId = Number(teamIdParam);
  if (!Number.isFinite(teamId)) {
    notFound();
  }

  const simulation = await getLatestSimulation();
  if (!simulation) {
    notFound();
  }

  const lookup = buildSimulationLookup(simulation);
  const teamContext = getTeamContext(simulation, teamId, lookup);
  if (!teamContext) {
    notFound();
  }

  const { team, standing, monteCarlo, schedule, nextMatchup } = teamContext;
  const playoffOdds = formatPercent(monteCarlo?.playoff_odds ?? null);
  const topSeedOdds = formatPercent(monteCarlo?.top_seed_odds ?? null);
  const bestSeedCopy = formatSeed(monteCarlo?.best_seed ?? null);
  const nextMatchupTone = nextMatchup ? probabilityTone(nextMatchup.win_probability) : null;
  const remainingGames = schedule.filter((entry) => !entry.isActual).length;

  return (
    <main className="shell">
      <article className="panel team-panel">
        <header className="team-hero">
          <div className="team-hero__identity">
            <div className="team-hero__logo">
              {team.logo_url ? (
                <Image
                  src={team.logo_url}
                  alt={`${team.name} logo`}
                  width={96}
                  height={96}
                  unoptimized
                  priority
                />
              ) : (
                <span aria-hidden>{team.abbrev ?? team.name.slice(0, 2).toUpperCase()}</span>
              )}
            </div>
            <div className="team-hero__meta">
              <h1>{team.name}</h1>
              <p className="team-hero__owners">{formatOwners(team.owners)}</p>
            </div>
          </div>
          <div className="team-hero__stats">
            {standing ? (
              <div>
                <span className="team-hero__label">Projected Record</span>
                <span className="team-hero__value">{formatRecord(standing.projected_record)}</span>
              </div>
            ) : null}
            {standing ? (
              <div>
                <span className="team-hero__label">Projected Points</span>
                <span className="team-hero__value">{standing.projected_points.toFixed(0)}</span>
              </div>
            ) : null}
            {playoffOdds ? (
              <div>
                <span className="team-hero__label">Playoff Odds</span>
                <span className="team-hero__value team-hero__value--accent">{playoffOdds}</span>
              </div>
            ) : null}
            {topSeedOdds ? (
              <div>
                <span className="team-hero__label">#1 Seed Odds</span>
                <span className="team-hero__value">{topSeedOdds}</span>
              </div>
            ) : null}
            {bestSeedCopy ? (
              <div>
                <span className="team-hero__label">Ceiling</span>
                <span className="team-hero__value">{bestSeedCopy}</span>
              </div>
            ) : null}
          </div>
        </header>

        {nextMatchup && nextMatchupTone ? (
          <section className="next-matchup">
            <div className={`probability-banner probability-banner--${nextMatchupTone}`}>
              <span>{probabilityLabel(nextMatchup.win_probability)}</span>
            </div>
            <header>
              <span className="next-matchup__eyebrow">Next Up · Week {nextMatchup.week}</span>
              <h2>
                {team.name} {nextMatchup.is_home ? "vs" : "@"}{" "}
                {nextMatchup.opponent ? (
                  <Link href={`/teams/${nextMatchup.opponent.team_id}`}>
                    {nextMatchup.opponent.name}
                  </Link>
                ) : (
                  `Team ${nextMatchup.opponent_team_id}`
                )}
              </h2>
            </header>
            <div className="next-matchup__body">
              <div className="next-matchup__stat">
                <span className="next-matchup__label">Projected</span>
                <span className="next-matchup__value">
                  {nextMatchup.projected_points.toFixed(1)} – {nextMatchup.opponent_projected_points.toFixed(1)}
                </span>
              </div>
              <div className="next-matchup__stat">
                <span className="next-matchup__label">Win Odds</span>
                <span className="next-matchup__value">{probabilityLabel(nextMatchup.win_probability)}</span>
              </div>
              <div className="next-matchup__stat">
                <span className="next-matchup__label">Margin</span>
                <span className="next-matchup__value">{formatMargin(nextMatchup.projected_margin)}</span>
              </div>
            </div>
            {nextMatchup.teamProjection ? (
              <div className="next-matchup__lineups">
                <div>
                  <h3>{team.name} Starters</h3>
                  <ul>
                    {nextMatchup.teamProjection.starters.map((player) => (
                      <li key={`${player.espn_player_id ?? player.player_name}-${player.lineup_slot}`}>
                        <span className="player-slot">{player.lineup_slot}</span>
                        <span className="player-name">{player.player_name}</span>
                        <span className="player-points">{player.projected_points.toFixed(1)} pts</span>
                      </li>
                    ))}
                  </ul>
                </div>
                {nextMatchup.opponentProjection ? (
                  <div>
                    <h3>
                      {nextMatchup.opponent ? nextMatchup.opponent.name : `Team ${nextMatchup.opponent_team_id}`} Starters
                    </h3>
                    <ul>
                      {nextMatchup.opponentProjection.starters.map((player) => (
                        <li key={`${player.espn_player_id ?? player.player_name}-${player.lineup_slot}`}>
                          <span className="player-slot">{player.lineup_slot}</span>
                          <span className="player-name">{player.player_name}</span>
                          <span className="player-points">{player.projected_points.toFixed(1)} pts</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="team-schedule">
          <header>
            <h2>Rest-of-Season Schedule</h2>
            <span>{remainingGames} games remaining</span>
          </header>
          <div className="team-schedule__grid">
            {schedule.map((entry) => {
              const opponent = entry.opponent;
              const opponentLabel = opponent ? opponent.name : `Team ${entry.opponent_team_id}`;
              const href = opponent ? `/teams/${opponent.team_id}` : null;
              const tone = entry.isActual
                ? entry.result === "win"
                  ? "favorable"
                  : entry.result === "loss"
                    ? "underdog"
                    : "coinflip"
                : probabilityTone(entry.win_probability);
              const scoreLine = `${(entry.actualPoints ?? entry.projected_points).toFixed(1)} – ${(entry.opponentActualPoints ?? entry.opponent_projected_points).toFixed(1)}`;
              const probabilityText = entry.isActual
                ? entry.result === "win"
                  ? `Won (${scoreLine})`
                  : entry.result === "loss"
                    ? `Lost (${scoreLine})`
                    : `Tied (${scoreLine})`
                : probabilityLabel(entry.win_probability);
              const marginCopy = entry.isActual
                ? formatFinalMargin(entry.projected_margin)
                : formatMargin(entry.projected_margin);
              return (
                <article
                  key={`${entry.week}-${entry.matchup_id}`}
                  className={`team-schedule__card probability-glow--${tone}`}
                >
                  <header>
                    <span className="team-schedule__week">Week {entry.week}</span>
                    <span className="team-schedule__direction">{entry.is_home ? "Home" : "Away"}</span>
                  </header>
                  <h3>
                    {entry.is_home ? "vs" : "@"}{" "}
                    {href ? <Link href={href}>{opponentLabel}</Link> : opponentLabel}
                  </h3>
                  <p className="team-schedule__projection">
                    {entry.isActual ? `Final ${scoreLine}` : `${entry.projected_points.toFixed(1)} – ${entry.opponent_projected_points.toFixed(1)}`}
                  </p>
                  <p className="team-schedule__prob">{probabilityText}</p>
                  <p className="team-schedule__margin">{marginCopy}</p>
                </article>
              );
            })}
          </div>
        </section>
      </article>
    </main>
  );
}
