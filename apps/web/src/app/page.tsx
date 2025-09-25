import { getLatestWeekSnapshot } from "@/lib/data";

function formatOwners(owners: string[]): string {
  if (owners.length === 0) return "Unclaimed";
  if (owners.length === 1) return owners[0];
  if (owners.length === 2) return `${owners[0]} & ${owners[1]}`;
  return `${owners[0]}, ${owners[1]} +`;
}

function pickClosestMatchup(
  matchups: NonNullable<Awaited<ReturnType<typeof getLatestWeekSnapshot>>>["matchups"],
) {
  return (
    matchups
      .filter((matchup) => matchup.home && matchup.away)
      .map((matchup) => ({
        matchup,
        delta: Math.abs(matchup.home!.total_points - matchup.away!.total_points),
      }))
      .sort((a, b) => a.delta - b.delta)[0]?.matchup || null
  );
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

  const { season, week, matchups, teamSummaries, topPerformers } = snapshot;
  const marquee = pickClosestMatchup(matchups);
  const topTotalPoints = teamSummaries.length > 0 ? teamSummaries[0].total_points : 1;

  return (
    <main className="page">
      <header className="hero">
        <div className="hero__meta">
          <span className="hero__eyebrow">Season {season}</span>
          <h1>Week {week} Heat Check</h1>
          <p>
            Every score below is sourced from the ESPN + nflverse pipeline. Refresh the backend, smash reload, and watch who’s cooking, who’s collapsing, and which bench bullets are still chambered.
          </p>
        </div>
        {marquee && marquee.home && marquee.away ? (
          <div className="hero__matchup">
            <div className="hero__heading">Game in the balance</div>
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
              <span>{Math.abs(marquee.home.total_points - marquee.away.total_points).toFixed(2)} pt swing</span>
              <p>
                {marquee.home.total_points >= marquee.away.total_points
                  ? `${marquee.home.team.name} hanging on with ${marquee.home.bench_points.toFixed(1)} pts idle.`
                  : `${marquee.away.team.name} charging while ${marquee.away.bench_points.toFixed(1)} pts wait on the pine.`}
              </p>
            </div>
          </div>
        ) : null}
      </header>

      <section className="section">
        <header className="section__header">
          <h2>Matchup Pulse</h2>
          <p>This is the league scoreboard, sorted by chaos. Tight games float to the top.</p>
        </header>
        <div className="matchups">
          {matchups
            .filter((matchup) => matchup.home && matchup.away)
            .sort((a, b) => {
              const deltaA = Math.abs(a.home!.total_points - a.away!.total_points);
              const deltaB = Math.abs(b.home!.total_points - b.away!.total_points);
              return deltaA - deltaB;
            })
            .map((matchup) => {
              const home = matchup.home!;
              const away = matchup.away!;
              const leader = home.total_points >= away.total_points ? home : away;
              const trailer = leader === home ? away : home;
              const delta = Math.abs(home.total_points - away.total_points);

              return (
                <article className="matchup-card" key={matchup.matchup_id}>
                  <header>
                    <span>Matchup {matchup.matchup_id}</span>
                    <strong>{delta.toFixed(2)} pt gap</strong>
                  </header>
                  <div className="matchup-card__body">
                    {[home, away].map((team) => (
                      <div key={team.team.team_id} className="matchup-card__team">
                        <div className="matchup-card__scoreline">
                          <strong>{team.total_points.toFixed(1)}</strong>
                          <span>{team.team.name}</span>
                        </div>
                        <p>
                          {team.top_player
                            ? `${team.top_player.player_name} dropped ${team.top_player.fantasy_points.toFixed(1)} (${team.top_player.lineup_slot || team.top_player.espn_position})`
                            : "Looking for a hero"}
                        </p>
                        <p className="muted">Bench ammo: {team.bench_points.toFixed(1)} pts</p>
                      </div>
                    ))}
                  </div>
                  <footer>
                    <span>
                      {leader.team.name} ahead by {delta.toFixed(2)}. {trailer.team.name} needs {delta.toFixed(2)}+ to flip the script.
                    </span>
                  </footer>
                </article>
              );
            })}
        </div>
      </section>

      <section className="section section--grid">
        <div className="section__header">
          <h2>Stat Monsters</h2>
          <p>Who carried their rosters this week? Starters only. Bench explosions don’t count.</p>
        </div>
        <ul className="leaders">
          {topPerformers.map((player, index) => {
            const team = teamSummaries.find((summary) => summary.team.team_id === player.team_id);
            return (
              <li key={`${player.team_id}-${player.player_name}`} className="leaders__item">
                <span className="leaders__rank">#{index + 1}</span>
                <div className="leaders__body">
                  <strong>{player.player_name}</strong>
                  <span>
                    {player.fantasy_points.toFixed(1)} pts · {player.lineup_slot || player.espn_position}
                  </span>
                  {team ? <em>{team.team.name}</em> : null}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="section__header">
          <h2>Team Heat Index</h2>
          <p>Total starter points vs bench stash, sorted by who brought the smoke.</p>
        </div>
        <ul className="teams">
          {teamSummaries.map((summary) => {
            const width = `${Math.min((summary.total_points / topTotalPoints) * 100, 100)}%`;

            return (
              <li key={summary.team.team_id} className="teams__item">
                <div className="teams__header">
                  <strong>{summary.team.name}</strong>
                  <span>{formatOwners(summary.team.owners)}</span>
                </div>
                <div className="teams__bar">
                  <span style={{ width }} />
                </div>
                <div className="teams__numbers">
                  <strong>{summary.total_points.toFixed(1)} pts</strong>
                  <em>Bench {summary.bench_points.toFixed(1)} pts</em>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
