"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplayMatchup, ReplayPlayer, ReplayTeam } from "@/lib/week-replay";
import type { StudioEpisode, StudioEpisodeResponse } from "@/lib/studio-episode";

type View = "final" | "play" | "lineup" | "episode";
type Scores = [number, number];
type Owners = StudioEpisodeResponse["owners"];
const points = (value: number) => value.toFixed(1);
const rounded = (value: number) => Math.round(value * 10) / 10;
const margin = (scores: Scores) => rounded(rounded(scores[0]) - rounded(scores[1]));
const headshot = (id: number) => `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`;

function Portrait({ name, url, className = "" }: { name: string; url?: string | null; className?: string }) {
  const [failed, setFailed] = useState<string>();
  const initials = name.split(/\s+/).filter(Boolean).map((part) => part[0]).filter((_, index, parts) => index === 0 || index === parts.length - 1).join("");
  return <span className={`replay-portrait ${className}`}>
    {url && failed !== url ? <Image src={url} alt={name} width={350} height={254} unoptimized onError={() => setFailed(url)} /> : <span className="replay-portrait-fallback" aria-label={`${name}, photo unavailable`}>{initials}</span>}
  </span>;
}

function useScores(initial: Scores) {
  const [scores, setScores] = useState<Scores>(initial);
  const frame = useRef<number | null>(null);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const show = useCallback((next: Scores) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null; setScores(next);
  }, []);
  const animate = useCallback((from: Scores, to: Scores, done?: () => void) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || (from[0] === to[0] && from[1] === to[1])) {
      frame.current = null; setScores(to); done?.(); return;
    }
    setScores(from);
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 500);
      const eased = 1 - (1 - progress) ** 3;
      setScores([from[0] + (to[0] - from[0]) * eased, from[1] + (to[1] - from[1]) * eased]);
      if (progress < 1) frame.current = requestAnimationFrame(tick);
      else { frame.current = null; done?.(); }
    };
    frame.current = requestAnimationFrame(tick);
  }, []);
  return { scores, show, animate };
}

function resultLabel(difference: number, final: boolean, hypothetical = false) {
  if (difference === 0) return "Tied on points";
  if (hypothetical) return difference > 0 ? "Would win" : "Would lose";
  if (final) return difference > 0 ? "Win" : "Loss";
  return difference > 0 ? "Leading" : "Trailing";
}

function Scoreboard({ replay, scores, final = false, hypothetical = false, portraits = false, owners = {} }: {
  replay: ReplayMatchup; scores: Scores; final?: boolean; hypothetical?: boolean; portraits?: boolean; owners?: Owners;
}) {
  const difference = margin(scores);
  return <div className={`replay-scoreboard${portraits ? " replay-scoreboard-portraits" : ""}`}>
    {[replay.team, replay.opponent].map((team, index) => {
      const lead = index === 0 ? difference : -difference;
      const tone = lead === 0 ? "tie" : lead > 0 ? "win" : "loss";
      return <div className={`replay-team replay-${tone}`} key={team.id}>
        <h3>{team.name}</h3><strong className="replay-score">{points(scores[index])}</strong>
        <span className="replay-result">{resultLabel(lead, final, hypothetical)}</span>
        {portraits && <TeamPortraits team={team} owners={owners[String(team.id)] ?? []} />}
      </div>;
    })}
  </div>;
}

function LeadingPlayer({ player }: { player: ReplayPlayer }) {
  return <figure className="replay-leading-player"><Portrait name={player.name} url={player.headshotUrl} /><figcaption>{player.name}<span>{points(player.points)} points</span></figcaption></figure>;
}

function TeamPortraits({ team, owners }: { team: ReplayTeam; owners: Owners[string] }) {
  const photographed = owners.filter((owner) => owner.portraitUrl);
  if (!photographed.length) return team.player ? <LeadingPlayer player={team.player} /> : null;
  return <div className="replay-owner-portraits">{photographed.map((owner) => <figure key={owner.id}><Portrait name={owner.name} url={owner.portraitUrl} /><figcaption>{owner.name}</figcaption></figure>)}</div>;
}

function FinalResult({ replay, owners }: { replay: ReplayMatchup; owners: Owners }) {
  const scores: Scores = [replay.team.score, replay.opponent.score];
  const difference = margin(scores);
  const final = replay.team.final && replay.opponent.final;
  let headline = "Level on points.";
  if (difference !== 0) {
    const word = final ? (difference > 0 ? "Won" : "Lost") : (difference > 0 ? "Leading" : "Trailing");
    headline = `${word} by ${points(Math.abs(difference))}.`;
  }
  const allPlay = replay.allPlay;
  return <div className="replay-scene replay-final">
    <div className="replay-scene-intro"><h2 className="replay-title">{headline}</h2><p>{final ? "Final score" : "Week in progress"}</p></div>
    <Scoreboard replay={replay} scores={scores} final={final} portraits owners={owners} />
    {final && allPlay && <p className="replay-final-context">{replay.team.name}&apos;s score would beat <strong>{allPlay.wins} of {allPlay.wins + allPlay.losses + allPlay.ties}</strong> other teams.{allPlay.ties > 0 && ` It would tie ${allPlay.ties}.`}</p>}
  </div>;
}

function TurningPoint({ replay }: { replay: ReplayMatchup }) {
  const play = replay.play!;
  const before: Scores = [play.before[String(replay.team.id)], play.before[String(replay.opponent.id)]];
  const after: Scores = [play.after[String(replay.team.id)], play.after[String(replay.opponent.id)]];
  const { scores, show, animate } = useScores(before);
  const [phase, setPhase] = useState<"before" | "playing" | "after">("before");
  const difference = margin(scores);
  const leading = difference >= 0 ? replay.team : replay.opponent;
  function start() { setPhase("playing"); animate(before, after, () => setPhase("after")); }
  return <div className="replay-scene replay-turning-point">
    <div className="replay-play-focus">
      <div className="replay-play-portrait"><Portrait name={play.playerName} url={headshot(play.playerId)} /><span className={`replay-play-points${play.points < 0 ? " replay-points-lost" : ""}${play.points === 0 ? " replay-points-neutral" : ""}`}>{play.points > 0 ? "+" : ""}{points(play.points)}<small>fantasy points</small></span></div>
      <div className="replay-play-story"><p className="replay-play-clock">Q{play.quarter} · {play.clock}</p><h2 className="replay-title">{play.playerName}</h2><p className="replay-description">{play.description}</p>
        <div className="replay-play-actions"><button type="button" className="replay-primary" onClick={start} disabled={phase === "playing"}><PlayIcon />{phase === "before" ? "Replay the play" : "Replay again"}</button>{phase !== "before" && <button type="button" className="replay-text-button" onClick={() => { show(before); setPhase("before"); }}>Before the play</button>}</div>
      </div>
    </div>
    <div className="replay-score-context"><p aria-live="polite">{phase === "before" ? "Before the play" : phase === "playing" ? "Play in motion" : "After the play"}</p><span>Reconstructed scores</span></div>
    <Scoreboard replay={replay} scores={scores} />
    <p className="replay-lead-change">{difference === 0 ? "The scores are level." : <>{leading.name} leads by <strong>{points(Math.abs(difference))}</strong>.</>}</p>
    <div className="replay-sources"><a href={play.sourceUrl} target="_blank" rel="noreferrer">Play record</a><details><summary>How the scores were reconstructed</summary><p>{play.methodNote}</p></details></div>
  </div>;
}

function BestLineup({ replay, owners }: { replay: ReplayMatchup; owners: Owners }) {
  const best = replay.bestLineup;
  const target = best.score!;
  const { scores, animate } = useScores([replay.team.score, replay.opponent.score]);
  useEffect(() => { animate([replay.team.score, replay.opponent.score], [target, replay.opponent.score]); }, [animate, replay.team.score, replay.opponent.score, target]);
  const difference = margin(scores);
  const actualDifference = rounded(replay.team.score - replay.opponent.score);
  let headline = "Tied, with the best lineup.";
  if (difference < 0) headline = `Still ${points(Math.abs(difference))} short.`;
  if (difference > 0) headline = actualDifference < 0 ? `A ${points(difference)}-point win instead.` : `Ahead by ${points(difference)}.`;
  return <div className="replay-scene replay-lineup">
    <div className="replay-scene-intro"><h2 className="replay-title">{headline}</h2><p>Hindsight, using final points</p></div>
    <Scoreboard replay={replay} scores={scores} hypothetical portraits owners={owners} />
    <p className="replay-lineup-gain">Actual <strong>{points(replay.team.score)}</strong><span aria-hidden="true"> / </span>Best <strong>{points(target)}</strong><span className="replay-gain">+{points(target - replay.team.score)} points</span></p>
    {best.moves.length ? <div className="replay-lineup-moves">{best.moves.map((move) => <figure key={`${move.id}-${move.to}`}><Portrait name={move.name} url={move.headshotUrl} /><figcaption><strong>{move.name}</strong><span>{move.from}<span className="replay-move-arrow">to</span>{move.to}</span><small>{points(move.points)} points</small></figcaption></figure>)}</div> : <p className="replay-lineup-unchanged">Your starters already made the best eligible lineup.</p>}
    <details className="replay-method"><summary>Lineup assumptions</summary><p>{best.caveat}</p></details>
  </div>;
}

function Episode({ episode, replay }: { episode: StudioEpisode; replay: ReplayMatchup }) {
  const [index, setIndex] = useState(() => Math.max(0, episode.scenes.findIndex((scene) => scene.assetUrl)));
  const [failedImage, setFailedImage] = useState<string>();
  const scene = episode.scenes[index];
  const team: ReplayTeam | undefined = [replay.team, replay.opponent].find((entry) => entry.id === episode.teamId);
  if (!scene) return null;
  const hasImage = scene.assetUrl && failedImage !== scene.assetUrl;
  return <div className="replay-scene replay-episode">
    <div className="replay-episode-heading"><div><h2 className="replay-title">{scene.title}</h2><p>{episode.title}{team ? ` · ${team.name}` : ""}</p></div><span className="replay-episode-number">{index + 1} / {episode.scenes.length}</span></div>
    {hasImage ? <Image className="replay-episode-art" src={scene.assetUrl!} alt={scene.title} width={1536} height={1024} unoptimized onError={() => setFailedImage(scene.assetUrl)} /> : <div className="replay-episode-cast">{scene.cast.filter((person) => person.portraitUrl).map((person) => <figure key={`${person.kind}-${person.id}`}><Portrait name={person.name} url={person.portraitUrl} /><figcaption>{person.name}</figcaption></figure>)}</div>}
    <p className="replay-episode-commentary">{scene.commentary}</p>
    {hasImage && <p className="replay-episode-fiction">Illustrated league scene</p>}
    {!!scene.cast.length && <p className="replay-cast-names">{scene.cast.map((person) => person.name).join(" · ")}</p>}
    {scene.assetUrl && failedImage === scene.assetUrl && <button type="button" className="replay-text-button" onClick={() => setFailedImage(undefined)}>Try the image again</button>}
    <div className="replay-episode-controls"><button type="button" onClick={() => setIndex(index - 1)} disabled={index === 0}><Chevron direction="left" />Previous scene</button><button type="button" onClick={() => setIndex(index + 1)} disabled={index === episode.scenes.length - 1}>Next scene<Chevron direction="right" /></button></div>
  </div>;
}

function PlayIcon() { return <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="m6 3 11 7-11 7Z" fill="currentColor" /></svg>; }
function Chevron({ direction }: { direction: "left" | "right" }) { return <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d={direction === "left" ? "m12 4-6 6 6 6" : "m8 4 6 6-6 6"} fill="none" stroke="currentColor" strokeWidth="1.7" /></svg>; }

export function WeekReplay({ replay, season, week }: { replay: ReplayMatchup; season: number; week: number }) {
  const [view, setView] = useState<View>("final");
  const [episode, setEpisode] = useState<StudioEpisode | null>(null);
  const [owners, setOwners] = useState<Owners>({});
  const [episodeError, setEpisodeError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setEpisode(null); setOwners({}); setEpisodeError(false);
    async function load() {
      try {
        const session = await fetch("/api/studio/session", { cache: "no-store", signal: controller.signal });
        if (!session.ok) throw new Error("Could not check saved episodes");
        if (!(await session.json()).authorized) return;
        const response = await fetch(`/api/studio/episode?season=${season}&week=${week}&teamId=${replay.team.id}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) return;
        if (!response.ok) throw new Error("Saved episode unavailable");
        const result = await response.json() as StudioEpisodeResponse;
        setOwners(result.owners ?? {});
        if (result.episode && result.episode.season === season && result.episode.week === week && [replay.team.id, replay.opponent.id].includes(result.episode.teamId) && result.episode.scenes.length) setEpisode(result.episode);
      } catch { if (!controller.signal.aborted) setEpisodeError(true); }
    }
    void load();
    return () => controller.abort();
  }, [season, week, replay.team.id, replay.opponent.id, retry]);
  const hasPlay = replay.play && [replay.team.id, replay.opponent.id].every((id) => Number.isFinite(replay.play?.before[String(id)]) && Number.isFinite(replay.play?.after[String(id)]));
  const hasLineup = replay.bestLineup.available && Number.isFinite(replay.bestLineup.score);
  const current = view === "episode" && !episode ? "final" : view;
  const views: { id: View; label: string }[] = [{ id: "final", label: replay.team.final && replay.opponent.final ? "Final" : "Score" }, ...(hasPlay ? [{ id: "play" as const, label: "Turning point" }] : []), ...(hasLineup ? [{ id: "lineup" as const, label: "Best lineup" }] : []), ...(episode ? [{ id: "episode" as const, label: "Episode" }] : [])];
  return <section className="week-replay" aria-label={`${replay.team.name} versus ${replay.opponent.name} replay`}>
    <nav className="replay-views" aria-label="Matchup views">{views.map((entry) => <button type="button" key={entry.id} aria-pressed={current === entry.id} onClick={() => setView(entry.id)}>{entry.label}</button>)}</nav>
    <div className="replay-stage">{current === "final" && <FinalResult replay={replay} owners={owners} />}{current === "play" && hasPlay && <TurningPoint replay={replay} />}{current === "lineup" && hasLineup && <BestLineup replay={replay} owners={owners} />}{current === "episode" && episode && <Episode key={episode.id} episode={episode} replay={replay} />}</div>
    {episodeError && <p className="replay-episode-retry">Saved episode unavailable. <button type="button" onClick={() => setRetry((value) => value + 1)}>Try again</button></p>}
  </section>;
}
