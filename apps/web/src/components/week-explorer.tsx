"use client";

import { useState } from "react";
import type { LeagueWeek, WeekTeam } from "@/lib/league-week";

const points = (value: number | null) => value === null ? "N/A" : value.toFixed(1);
const signed = (value: number) => `${value > 0 ? "+" : ""}${points(value)}`;
const outcome = (score: number, opponentScore: number) => Math.abs(score - opponentScore) < 0.001 ? "Tied on points" : score > opponentScore ? "Win" : "Loss";

function PlayerList({ team, bench = false }: { team: WeekTeam; bench?: boolean }) {
  const players = team.players.filter((player) => player.starter !== bench);
  return <ul className="week-players">
    {players.map((player) => <li key={player.id}>
      <span className="week-position">{bench ? player.position : player.slot}</span>
      <span>{player.name}</span><strong>{points(player.points)}</strong>
    </li>)}
  </ul>;
}

export function WeekExplorer({ report, initialTeamId }: { report: LeagueWeek; initialTeamId?: number }) {
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

  function selectTeam(id: number) {
    setTeamId(id); setOutId(""); setInId("");
    const url = new URL(window.location.href);
    url.searchParams.set("team", String(id));
    window.history.replaceState(null, "", url);
  }

  return <>
    <section className="week-results" aria-labelledby="results-title">
      <div className="week-section-heading"><h2 id="results-title">Around the league</h2><p>{report.matchups.length} matchups {report.complete ? "final" : "in progress"}</p></div>
      <div className="week-results-grid">
        {report.matchups.map((matchup) => {
          const home = report.teams.find((entry) => entry.id === matchup.homeId);
          const away = report.teams.find((entry) => entry.id === matchup.awayId);
          if (!home || !away) return null;
          return <button key={matchup.id} type="button" className="week-matchup" aria-pressed={team.matchupId === matchup.id} onClick={() => selectTeam(home.id)}>
            {[home, away].map((entry) => <span className="week-matchup-row" key={entry.id}>
              <span>{entry.name}</span><strong>{points(entry.score)}</strong>
            </span>)}
          </button>;
        })}
      </div>
    </section>

    <section className="week-investigate" aria-labelledby="team-title">
      <div className="week-section-heading week-team-heading">
        <div><h2 id="team-title">How your week played out</h2><p>Choose a team to revisit its lineup and opponents.</p></div>
        <label className="week-field">Team<select value={team.id} onChange={(event) => selectTeam(Number(event.target.value))}>
          {report.teams.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
      </div>
      <div className="week-workspace">
        <div>
          <div className="week-official-result">
            <span>{team.name}<strong>{points(team.score)}</strong></span>
            <span className="week-result-word">{team.final ? "Final" : "In progress"}</span>
            <span>{team.opponentName}<strong>{points(team.opponentScore)}</strong></span>
          </div>
          <div className="week-lineups">
            <section aria-label={`${team.name} lineup`}><h3>{team.name}</h3><PlayerList team={team} />
              <details className="week-bench"><summary>Bench and reserve ({team.players.filter((player) => !player.starter).length})</summary><PlayerList team={team} bench /></details>
            </section>
            {opponent && <section aria-label={`${opponent.name} lineup`}><h3>{opponent.name}</h3><PlayerList team={opponent} />
              <details className="week-bench"><summary>Bench and reserve ({opponent.players.filter((player) => !player.starter).length})</summary><PlayerList team={opponent} bench /></details>
            </section>}
          </div>
          <p className="week-caption">Official Week {report.week} lineups and ESPN points. {report.complete && team.lineupReconciled && opponent?.lineupReconciled ? "Both starter totals match the final scores." : "Scores can change until the week is final."}</p>

          {report.complete && <section className="week-substitution" aria-labelledby="substitution-title">
            <h3 id="substitution-title">One bench decision</h3>
            <p>Replay the week with one eligible bench player in a starter&apos;s slot.</p>
            <div className="week-swap-fields">
              <label className="week-field">Take out<select value={outId} onChange={(event) => { setOutId(event.target.value); setInId(""); }}>
                <option value="">Choose a starter</option>
                {starters.filter((player) => player.points !== null).map((player) => <option key={player.id} value={player.id}>{player.name} ({player.slot}, {points(player.points)})</option>)}
              </select></label>
              <label className="week-field">Put in<select value={inId} disabled={!outgoing || !eligible.length} onChange={(event) => setInId(event.target.value)}>
                <option value="">{outgoing && !eligible.length ? "No eligible bench player" : "Choose a bench player"}</option>
                {eligible.map((player) => <option key={player.id} value={player.id}>{player.name} ({points(player.points)})</option>)}
              </select></label>
            </div>
            <div aria-live="polite" className="week-swap-result">
              {substitution ? <><strong>{points(revisedScore)} to {points(team.opponentScore)}</strong><p>{outcome(revisedScore, team.opponentScore)}{Math.abs(revisedScore - team.opponentScore) >= 0.001 ? ` by ${points(Math.abs(revisedScore - team.opponentScore))}` : ""}. {signed(revisedScore - team.score)} points from starting {substitution.incoming.name} instead of {substitution.outgoing.name}.</p><button type="button" onClick={() => { setOutId(""); setInId(""); }}>Reset to official lineup</button></> : <p>Your official score stays {points(team.score)} until you choose both players.</p>}
            </div>
            <p className="week-caption">Retrospective slot eligibility from ESPN. This replay uses final points and does not reconstruct kickoff locks or what was known before the games.</p>
          </section>}
        </div>

        {report.complete ? <aside className="week-allplay" aria-labelledby="allplay-title">
          <h3 id="allplay-title">If you played everyone</h3>
          <p className="week-allplay-record">{wins}<span> wins from {others.length} opponents</span></p>
          <p>{substitution ? "Your revised" : "Your official"} {points(revisedScore)} points would finish {wins}–{others.length - wins - ties}{ties ? `–${ties}` : ""} against this week&apos;s scores.</p>
          <ul>{others.map((entry) => <li key={entry.id}><span>{entry.name}{entry.id === team.opponentId && <small>Your matchup</small>}</span><strong>{points(entry.score)}</strong><span className={outcome(revisedScore, entry.score) === "Win" ? "week-comparison-win" : ""}>{outcome(revisedScore, entry.score)}</span></li>)}</ul>
          <p className="week-caption">Each comparison uses the same weekly score. It shows schedule luck; the league standings stay unchanged.</p>
        </aside> : <aside className="week-allplay"><h3>The week is still in progress</h3><p>Once every matchup is final, compare every opponent and replay a bench decision here.</p></aside>}
      </div>
    </section>
  </>;
}
