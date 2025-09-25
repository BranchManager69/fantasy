import {
  getLatestWeekSnapshot,
  type MatchupSummary,
  type TeamWeekSummary,
} from "@/lib/data";

function formatOwners(owners: string[]): string {
  if (owners.length === 0) return "Unclaimed";
  if (owners.length === 1) return owners[0];
  if (owners.length === 2) return `${owners[0]} & ${owners[1]}`;
  return `${owners[0]}, ${owners[1]} +`;
}

function resolveMatchupDelta(matchup: MatchupSummary): number | null {
  if (!matchup.home || !matchup.away) {
    return null;
  }
  const delta = Math.abs(matchup.home.total_points - matchup.away.total_points);
  return Number(delta.toFixed(2));
}

function pickClosestMatchup(matchups: MatchupSummary[]) {
  return matchups
    .filter((matchup) => matchup.home && matchup.away)
    .map((matchup) => ({ matchup, delta: resolveMatchupDelta(matchup) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.delta - b.delta)[0]?.matchup;
}

function resolveMatchupStatus(matchup: MatchupSummary): "final" | "live" | "upcoming" {
  if (matchup.winner && matchup.home && matchup.away) {
    return "final";
  }
  if ((matchup.home?.total_points ?? 0) > 0 || (matchup.away?.total_points ?? 0) > 0) {
    return "live";
  }
  return "upcoming";
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return "Awaiting first sync";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Awaiting first sync";
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function differentialFromAverage(total: number, average: number): string {
  const diff = total - average;
  const rounded = Number(diff.toFixed(1));
  if (Math.abs(rounded) < 0.1) {
    return "On league pace";
  }
  if (rounded > 0) {
    return `+${rounded.toFixed(1)} vs league avg`;
  }
  return `${rounded.toFixed(1)} vs league avg`;
}

function trailingNeedCopy(trailer: TeamWeekSummary, delta: number): string {
  if (delta < 1) {
    return `${trailer.team.name} needs a single play to steal it.`;
  }
  if (delta < 10) {
    return `${trailer.team.name} is within ${delta.toFixed(1)} pts—still in striking range.`;
  }
  return `${trailer.team.name} must erase ${delta.toFixed(1)} pts.`;
}

function topPerformerContext(
  playerTeam: TeamWeekSummary | undefined,
  points: number,
): string {
  if (!playerTeam) {
    return `${points.toFixed(1)} pts`;
  }
  return `${points.toFixed(1)} pts · ${playerTeam.team.name}`;
}

export default async function Home() {
  const snapshot = await getLatestWeekSnapshot();

  if (!snapshot) {
    return (
      <main className="page">
        <section className="empty">
          <h1>No weekly artifacts yet</h1>
          <p>
            Run your backend refresh (`poetry run fantasy refresh-week --week N`) and reload. As soon as the CSVs land under
            <code>data/out/espn/&lt;season&gt;</code> this dashboard lights up with the real numbers.
          </p>
        </section>
      </main>
    );
  }

  const { season, week, matchups, teamSummaries, topPerformers, generatedAt, metrics } = snapshot;

  const marquee = pickClosestMatchup(matchups);
  const topTotalPoints = teamSummaries.length > 0 ? teamSummaries[0].total_points : 1;
  const standingsLow = teamSummaries[teamSummaries.length - 1];
  const scoreboard = [...matchups]
    .filter((matchup) => matchup.home && matchup.away)
    .sort((a, b) => {
      const statusOrder = { live: 0, final: 1, upcoming: 2 } as const;
      const aStatus = statusOrder[resolveMatchupStatus(a)];
      const bStatus = statusOrder[resolveMatchupStatus(b)];
      if (aStatus !== bStatus) {
        return aStatus - bStatus;
      }
      const deltaA = resolveMatchupDelta(a) ?? Number.POSITIVE_INFINITY;
      const deltaB = resolveMatchupDelta(b) ?? Number.POSITIVE_INFINITY;
      return deltaA - deltaB;
    });

  return (
    <main className="page">
      <header className="hero">
        <div className="hero__meta">
          <span className="hero__eyebrow">Season {season} · Week {week}</span>
          <h1>League Pulse</h1>
          <p>
            Live standings, sourced straight from the engine. Refresh the backend, reload the page, and watch the league narrative update in real time.
          </p>
        </div>
        <div className="hero__metrics">
          <div className="metric-card">
            <span className="metric-card__label">League Average</span>
            <strong>{metrics.averagePoints.toFixed(1)} pts</strong>
            <span>Median {metrics.medianPoints.toFixed(1)} pts</span>
          </div>
          {teamSummaries[0] ? (
            <div className="metric-card">
              <span className="metric-card__label">High Score</span>
              <strong>{metrics.highScore.toFixed(1)} pts</strong>
              <span>{teamSummaries[0].team.name}</span>
            </div>
          ) : null}
          {standingsLow ? (
            <div className="metric-card">
              <span className="metric-card__label">Low Score</span>
              <strong>{metrics.lowScore.toFixed(1)} pts</strong>
              <span>{standingsLow.team.name}</span>
            </div>
          ) : null}
          <div className="metric-card metric-card--timestamp">
            <span className="metric-card__label">Last Sync</span>
            <strong>{formatTimestamp(generatedAt)}</strong>
            <span>Artifacts · data/out/espn/{season}</span>
          </div>
        </div>
        {marquee && marquee.home && marquee.away ? (
          <div className="hero__matchup">
            <div className="hero__heading">Closest Battle</div>
            <div className="hero__teams">
              <div className="hero__team">
                <h3>{marquee.home.team.name}</h3>
                <span>{formatOwners(marquee.home.team.owners)}</span>
              </div>
              <div className="hero__score">
                <strong>{marquee.home.total_points.toFixed(1)}</strong>
                <span>vs</span>
                <strong>{marquee.away.total_points.toFixed(1)}</strong>
              </div>
              <div className="hero__team hero__team--right">
                <h3>{marquee.away.team.name}</h3>
                <span>{formatOwners(marquee.away.team.owners)}</span>
              </div>
            </div>
            <div className="hero__delta">
              <span>{resolveMatchupDelta(marquee)?.toFixed(2)} pt gap</span>
              <p>
                {marquee.home.total_points >= marquee.away.total_points
                  ? trailingNeedCopy(marquee.away, resolveMatchupDelta(marquee) ?? 0)
                  : trailingNeedCopy(marquee.home, resolveMatchupDelta(marquee) ?? 0)}
              </p>
            </div>
          </div>
        ) : null}
      </header>

      <section className="section">
        <header className="section__header">
          <h2>Scoreboard</h2>
          <p>Live games float to the top. Finals roll in once the engine exports.</p>
        </header>
        <div className="matchups">
          {scoreboard.map((matchup) => {
            const home = matchup.home!;
            const away = matchup.away!;
            const leader = home.total_points >= away.total_points ? home : away;
            const trailer = leader === home ? away : home;
            const delta = resolveMatchupDelta(matchup) ?? 0;
            const status = resolveMatchupStatus(matchup);

            return (
              <article className={`matchup-card matchup-card--${status}`} key={matchup.matchup_id}>
                <header>
                  <span className="matchup-card__status">
                    {status === "final" ? "Final" : status === "live" ? "Live" : "Scheduled"}
                  </span>
                  <strong>{delta.toFixed(2)} pt {status === "final" ? "margin" : "lead"}</strong>
                </header>
                <div className="matchup-card__body">
                  {[home, away].map((team) => {
                    const isLeader = team === leader;
                    return (
                      <div
                        key={team.team.team_id}
                        className={`matchup-card__team${isLeader ? " matchup-card__team--leader" : ""}`}
                      >
                        <div className="matchup-card__scoreline">
                          <div>
                            <span className="matchup-card__team-name">{team.team.name}</span>
                            <span className="matchup-card__owners">{formatOwners(team.team.owners)}</span>
                          </div>
                          <strong>{team.total_points.toFixed(1)}</strong>
                        </div>
                        {team.top_player ? (
                          <p className="matchup-card__highlight">
                            {team.top_player.player_name} · {team.top_player.fantasy_points.toFixed(1)} pts ({
                              team.top_player.lineup_slot || team.top_player.espn_position
                            })
                          </p>
                        ) : (
                          <p className="matchup-card__highlight">Looking for a spark</p>
                        )}
                        {team.bench_points > 0 ? (
                          <p className="matchup-card__bench">Bench potential: {team.bench_points.toFixed(1)} pts</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <footer>
                  <span>
                    {status === "final"
                      ? `${leader.team.name} takes it by ${delta.toFixed(2)}.`
                      : trailingNeedCopy(trailer, delta)}
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      </section>

      <section className="section section--grid">
        <div className="section__header">
          <h2>Top Performers</h2>
          <p>Starter-only output ranked by fantasy points.</p>
        </div>
        <ul className="leaders">
          {topPerformers.map((player, index) => {
            const team = teamSummaries.find((summary) => summary.team.team_id === player.team_id);
            return (
              <li key={`${player.team_id}-${player.player_name}`} className="leaders__item">
                <span className="leaders__rank">#{index + 1}</span>
                <div className="leaders__body">
                  <strong>{player.player_name}</strong>
                  <span>{player.lineup_slot || player.espn_position}</span>
                  <span className="leaders__meta">
                    {topPerformerContext(team, player.fantasy_points)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="section__header">
          <h2>Team Heat Index</h2>
          <p>Starter totals ranked vs league average.</p>
        </div>
        <ul className="teams">
          {teamSummaries.map((summary, index) => {
            const width = `${Math.min((summary.total_points / topTotalPoints) * 100, 100)}%`;

            return (
              <li key={summary.team.team_id} className="teams__item">
                <div className="teams__rank">#{index + 1}</div>
                <div className="teams__header">
                  <strong>{summary.team.name}</strong>
                  <span>{formatOwners(summary.team.owners)}</span>
                </div>
                <div className="teams__bar">
                  <span style={{ width }} />
                </div>
                <div className="teams__numbers">
                  <strong>{summary.total_points.toFixed(1)} pts</strong>
                  <em>{differentialFromAverage(summary.total_points, metrics.averagePoints)}</em>
                </div>
                {summary.bench_points > 0 ? (
                  <div className="teams__bench">Bench potential: {summary.bench_points.toFixed(1)} pts</div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
