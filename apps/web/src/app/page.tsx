import Link from "next/link";
import { WeekExplorer } from "@/components/week-explorer";
import { loadLeagueWeek } from "@/lib/league-week";
import { buildWeekReplays } from "@/server/week-replay";
import "./week.css";
import "./replay.css";

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
  const replays = await buildWeekReplays(report, moments);
  const selectedTeam = report.teams.find((team) => team.id === Number(params.team))
    ?? report.teams.find((team) => team.id === Number(process.env.FANTASY_DEFAULT_TEAM_ID || 8));
  const updated = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(report.generatedAt));

  return <main className="week-page"><div className="week-wrap">
    <header className="week-masthead">
      <Link href="/" className="week-brand">{report.leagueName}</Link>
      <span className="week-edition">{report.season} season</span>
      <nav className="week-nav" aria-label="League navigation"><a href="#results-title">The league</a><Link href="/season">Season outlook</Link><Link href="/studio">Studio</Link></nav>
    </header>

    <WeekExplorer report={report} replays={replays} initialTeamId={selectedTeam?.id} />

    <footer className="week-footer"><span>Report prepared {updated} UTC.</span><a href={report.sourceUrl} target="_blank" rel="noreferrer">View the ESPN scoreboard</a>{moments?.lead && <a href={moments.lead.source_url} target="_blank" rel="noreferrer">NFL play-by-play source</a>}</footer>
  </div></main>;
}
