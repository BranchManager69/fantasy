"use client";

import { useState } from "react";
import type { LeagueWeek, WeekTeam } from "@/lib/league-week";
import { LeagueAnalyst } from "@/components/league-analyst";
import { PlayerPortrait } from "@/components/player-portrait";
import { WeekReplay } from "@/components/week-replay";
import type { WeekReplays } from "@/lib/week-replay";
import type { WeekLeagueOverview } from "@/lib/league-overview";
import type { WeekLeagueMedia } from "@/lib/league-media";
import { LeagueMatchups, ScoreLadder, TeamIdentityImage } from "@/components/league-board";

const points = (value: number | null) => value === null ? "N/A" : value.toFixed(1);
const signed = (value: number) => `${value > 0 ? "+" : ""}${points(value)}`;
const outcome = (score: number, opponentScore: number) => Math.abs(score - opponentScore) < 0.001 ? "Tied on points" : score > opponentScore ? "Win" : "Loss";

function PlayerList({ team, bench = false }: { team: WeekTeam; bench?: boolean }) {
  const players = team.players.filter((player) => player.starter !== bench);
  return <ul className="week-players">
    {players.map((player) => <li key={player.id}>
      <span className="week-position">{bench ? player.position : player.slot}</span>
      <PlayerPortrait id={player.id} name={player.name} />
      <span>{player.name}</span><strong>{points(player.points)}</strong>
    </li>)}
  </ul>;
}

export function WeekExplorer({ report, replays, overview, media, initialTeamId }: { report: LeagueWeek; replays: WeekReplays; overview: WeekLeagueOverview; media: WeekLeagueMedia; initialTeamId?: number }) {
  const [teamId, setTeamId] = useState(initialTeamId ?? report.teams[0]?.id);
  const [outId, setOutId] = useState("");
  const [inId, setInId] = useState("");
  const team = report.teams.find((entry) => entry.id === teamId) ?? report.teams[0];
  if (!team) return <p>The weekly report has no teams yet.</p>;
  const opponent = report.teams.find((entry) => entry.id === team.opponentId);
  const starters = team.players.filter((player) => player.starter);
  const outgoing = starters.find((player) => player.points !== null && String(player.id) === outId);
  const eligible = outgoing ? team.players.filter((player) => !player.starter && player.slotId === 20 && player.points !== null && player.eligibleSlots.includes(outgoing.slotId)) : [];
  const incoming = eligible.find((player) => String(player.id) === inId);
  const substitution = outgoing && incoming && outgoing.points !== null && incoming.points !== null ? { outgoing, incoming } : null;
  const scoreChange = outgoing?.points != null && incoming?.points != null ? incoming.points - outgoing.points : 0;
  const revisedScore = Number((team.score + (substitution ? scoreChange : 0)).toFixed(1));
  const others = report.teams.filter((entry) => entry.id !== team.id).sort((a, b) => b.score - a.score);
  const wins = others.filter((entry) => revisedScore > entry.score + 0.001).length;
  const ties = others.filter((entry) => Math.abs(revisedScore - entry.score) < 0.001).length;

  function selectTeam(id: number, reveal = false) {
    setTeamId(id); setOutId(""); setInId("");
    const url = new URL(window.location.href);
    url.searchParams.set("team", String(id));
    window.history.replaceState(null, "", url);
    if (reveal) requestAnimationFrame(() => document.getElementById("week-watch")?.scrollIntoView({
      block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    }));
  }

  return <>
    <section id="week-watch" className="week-watch" aria-labelledby="week-watch-title">
      <div className="week-watch-heading">
        <h1 id="week-watch-title">Week {report.week}</h1>
        <label className="week-field"><span className="sr-only">Choose a team</span><select value={team.id} onChange={(event) => selectTeam(Number(event.target.value))}>
          {report.teams.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
      </div>
      <div className="week-league-stage">
        {replays[String(team.id)] && <WeekReplay key={`${report.season}-${report.week}-${team.id}`} replay={replays[String(team.id)]} season={report.season} week={report.week} overview={overview} media={media} />}
        <ScoreLadder report={report} overview={overview} media={media} selectedTeamId={team.id} onSelect={(id) => selectTeam(id, true)} />
      </div>
    </section>
    <LeagueMatchups report={report} overview={overview} media={media} selectedTeamId={team.id} onSelect={(id) => selectTeam(id, true)} />
    <LeagueAnalyst key={`${report.season}-${report.week}-${team.id}`} season={report.season} week={report.week} teamId={team.id} teamName={team.name} />

    <details className="week-lineup-details">
      <summary>Lineups and bench decisions</summary>
      <div className="week-workspace">
        <div>
          <div className="week-lineups">
            <section aria-label={`${team.name} lineup`}><h3>{team.name}</h3><PlayerList team={team} />
              <details className="week-bench"><summary>Bench and reserve ({team.players.filter((player) => !player.starter).length})</summary><PlayerList team={team} bench /></details>
            </section>
            {opponent && <section aria-label={`${opponent.name} lineup`}><h3>{opponent.name}</h3><PlayerList team={opponent} />
              <details className="week-bench"><summary>Bench and reserve ({opponent.players.filter((player) => !player.starter).length})</summary><PlayerList team={opponent} bench /></details>
            </section>}
          </div>
          <p className="week-caption">Week {report.week} lineups and points from ESPN.{!report.complete && " Scores can change until final."}</p>

          {report.complete && <section className="week-substitution" aria-labelledby="substitution-title">
            <h3 id="substitution-title">One bench decision</h3>
            <p>Would one swap have changed the result?</p>
            <div className="week-swap-fields">
              <label className="week-field">Take out<span className="week-player-select">{outgoing && <PlayerPortrait id={outgoing.id} name={outgoing.name} />}<select value={outId} onChange={(event) => { setOutId(event.target.value); setInId(""); }}>
                <option value="">Choose a starter</option>
                {starters.filter((player) => player.points !== null).map((player) => <option key={player.id} value={player.id}>{player.name} ({player.slot}, {points(player.points)})</option>)}
              </select></span></label>
              <label className="week-field">Put in<span className="week-player-select">{incoming && <PlayerPortrait id={incoming.id} name={incoming.name} />}<select value={inId} disabled={!outgoing || !eligible.length} onChange={(event) => setInId(event.target.value)}>
                <option value="">{outgoing && !eligible.length ? "No eligible bench player" : "Choose a bench player"}</option>
                {eligible.map((player) => <option key={player.id} value={player.id}>{player.name} ({points(player.points)})</option>)}
              </select></span></label>
            </div>
            <div aria-live="polite" className="week-swap-result">
              {substitution && <><strong>{points(revisedScore)} to {points(team.opponentScore)}</strong><p>{outcome(revisedScore, team.opponentScore)}{Math.abs(revisedScore - team.opponentScore) >= 0.001 ? ` by ${points(Math.abs(revisedScore - team.opponentScore))}` : ""}. {signed(revisedScore - team.score)} points from starting {substitution.incoming.name} instead of {substitution.outgoing.name}.</p><button type="button" onClick={() => { setOutId(""); setInId(""); }}>Reset lineup</button></>}
            </div>
            <details className="week-method"><summary>Replay assumptions</summary><p className="week-caption">Retrospective slot eligibility from ESPN, using final points. Kickoff locks and pregame information are outside this replay.</p></details>
          </section>}
        </div>

        {report.complete ? <aside className="week-allplay" aria-labelledby="allplay-title">
          <h3 id="allplay-title">Against every team</h3>
          <p className="week-allplay-record">{wins}–{others.length - wins - ties}{ties ? `–${ties}` : ""}<span> with {points(revisedScore)} points{substitution ? " after your swap" : ""}</span></p>
          <ul>{others.map((entry) => {
            const comparison = outcome(revisedScore, entry.score);
            return <li key={entry.id}>
              <TeamIdentityImage team={entry} media={media} />
              <span>{entry.name}{entry.id === team.opponentId && <small>Your matchup</small>}</span><strong>{points(entry.score)}</strong><span className={comparison === "Win" ? "week-positive" : comparison === "Loss" ? "week-negative" : ""}>{comparison === "Tied on points" ? "Tie" : comparison}</span>
            </li>;
          })}</ul>
          <p className="week-caption">Your score against each opponent. League standings stay unchanged.</p>
        </aside> : <aside className="week-allplay"><h3>The week is still in progress</h3><p>Once every matchup is final, compare every opponent and replay a bench decision here.</p></aside>}
      </div>
    </details>
  </>;
}
