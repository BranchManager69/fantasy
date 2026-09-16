import Link from "next/link";
import { WeekExplorer } from "@/components/week-explorer";
import { PlayerPortrait } from "@/components/player-portrait";
import { loadLeagueWeek } from "@/lib/league-week";
import "./week.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = { team?: string; season?: string; week?: string };

export default async function Home({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = searchParams ? await searchParams : {};
  const season = /^20\d{2}$/.test(params.season ?? "") ? Number(params.season) : 2026;
  const week = /^(?:[1-9]|1[0-8])$/.test(params.week ?? "") ? Number(params.week) : 1;
  const { report, moments } = await loadLeagueWeek(season, week);
  if (!report) return <main className="week-page"><div className="week-wrap"><section className="week-empty">
    <h1>That week is still on the way.</h1><p>The Week {week} report for {season} has not been prepared yet.</p><Link href="/">Return to Week 1</Link>
  </section></div></main>;
  const lead = moments?.lead;
  const leadTeam = report.teams.find((team) => team.id === lead?.team_id);
  const leadPlayer = leadTeam?.players.find((player) => player.name === lead?.player_name);
  const featuredTeams = lead ? report.teams.filter((team) => String(team.id) in lead.before) : [];
  const selectedTeam = report.teams.find((team) => team.id === Number(params.team));
  const updated = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(report.generatedAt));

  return <main className="week-page"><div className="week-wrap">
    <header className="week-masthead">
      <Link href="/" className="week-brand">{report.leagueName}</Link>
      <span className="week-edition">Week {report.week}, {report.season}</span>
      <nav className="week-nav" aria-label="League navigation"><a href="#team-title">Explore your week</a><Link href="/season">Season outlook</Link></nav>
    </header>

    <section className="week-hero" aria-labelledby="lead-title">
      <div><h1 id="lead-title">{lead?.title ?? `Week ${report.week}, ${report.complete ? "in the books" : "as it stands"}.`}</h1>
        <p className="week-deck">{lead?.summary ?? (report.complete ? `${report.teams.length} teams, ${report.matchups.length} matchups. Revisit the scores, compare every opponent, and try one different lineup decision.` : `Follow the scores and lineups across ${report.matchups.length} matchups as the week unfolds.`)}</p>
      </div>
      {lead && <aside className="week-play" aria-label="The featured play">
        <div className="week-play-athlete">
          <PlayerPortrait id={leadPlayer?.id} name={lead.player_name} className="week-portrait-feature" priority />
          <div><h2>{lead.player_name}</h2>
            <p className="week-play-context">{lead.quarter > 4 ? "Overtime" : `Q${lead.quarter}`} · {lead.clock}</p>
            <p className="week-play-points">{lead.fantasy_points > 0 ? "+" : ""}{lead.fantasy_points.toFixed(1)}<span>points</span></p>
          </div>
        </div>
        <table><caption className="sr-only">Reconstructed matchup score before and after the play</caption><thead><tr><th scope="col">Matchup</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
          <tbody>{featuredTeams.map((team) => <tr key={team.id}><td>{team.name}</td><td>{lead.before[String(team.id)].toFixed(1)}</td><td>{lead.after[String(team.id)].toFixed(1)}</td></tr>)}</tbody>
        </table>
        <div className="week-play-links">
          {report.season === 2026 && report.week === 1 && leadPlayer?.id === 4567048 && <a href="https://www.chiefs.com/video/can-t-miss-play-kenneth-walker-unleashes-his-speed-on-60-yard-touchdown" target="_blank" rel="noreferrer">Watch the touchdown</a>}
          <details className="week-play-note"><summary>Score reconstruction</summary><p>Corrected play-by-play and official Week {report.week} lineups.</p></details>
        </div>
      </aside>}
    </section>

    {!!moments?.moments.length && <section className="week-other-moments" aria-label="More plays from the featured matchup">
      {moments.moments.filter((moment) => moment.player_name !== lead?.player_name).map((moment) => {
        const player = report.teams.find((team) => team.id === moment.team_id)?.players.find((entry) => entry.name === moment.player_name);
        return <article key={moment.id}>
          <PlayerPortrait id={player?.id} name={moment.player_name} className="week-portrait-moment" />
          <div><h3>{moment.player_name} <span className={moment.fantasy_points < 0 ? "week-negative" : "week-positive"}>{moment.fantasy_points > 0 ? "+" : ""}{moment.fantasy_points.toFixed(1)}</span></h3>
            <p>{moment.description}</p><details><summary>Scoring detail</summary><p>{moment.note}</p><a href={moment.source_url} target="_blank" rel="noreferrer">Play-by-play source</a></details>
          </div>
        </article>;
      })}
    </section>}

    <WeekExplorer report={report} initialTeamId={selectedTeam?.id ?? leadTeam?.id} />

    <footer className="week-footer"><span>Report prepared {updated} UTC.</span><a href={report.sourceUrl} target="_blank" rel="noreferrer">View the ESPN scoreboard</a>{lead && <a href={lead.source_url} target="_blank" rel="noreferrer">NFL play-by-play source</a>}</footer>
  </div></main>;
}
