"use client";

import Image from "next/image";
import { useId, useState } from "react";
import type { LeagueWeek, WeekTeam } from "@/lib/league-week";
import type { WeekLeagueOverview } from "@/lib/league-overview";
import type { WeekLeagueMedia, LeagueTeamImage } from "@/lib/league-media";

const points = (value: number) => value.toFixed(1);
const ordinal = (value: number) => `${value}${value % 100 >= 11 && value % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][value % 10] ?? "th")}`;

function IdentityPhoto({ photo, teamName, onError }: { photo: LeagueTeamImage; teamName: string; onError: () => void }) {
  const clipId = useId();
  const [dimensions, setDimensions] = useState({ width: photo.imageWidth ?? 0, height: photo.imageHeight ?? 0 });
  const crop = photo.crop;
  const name = photo.kind === "team-logo" ? `${teamName} team logo` : photo.peopleNames.length ? photo.peopleNames.join(", ") : teamName;
  return <span className={`league-image-frame${crop ? " league-image-cropped" : ""}`}>{crop && dimensions.width && dimensions.height ? <svg viewBox={`${crop.x * dimensions.width} ${crop.y * dimensions.height} ${crop.width * dimensions.width} ${crop.height * dimensions.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={name}><defs><clipPath id={clipId} clipPathUnits="userSpaceOnUse"><rect x={crop.x * dimensions.width} y={crop.y * dimensions.height} width={crop.width * dimensions.width} height={crop.height * dimensions.height} /></clipPath></defs><g clipPath={`url(#${clipId})`}><image href={photo.imageUrl} width={dimensions.width} height={dimensions.height} onError={onError} /></g></svg> : <Image src={photo.imageUrl} alt={name} width={480} height={360} unoptimized onLoad={(event) => { const image = event.currentTarget; if (image.naturalHeight) setDimensions({ width: image.naturalWidth, height: image.naturalHeight }); }} onError={onError} />}</span>;
}

export function TeamIdentityImage({ team, media, caption = false }: { team: { id: number; name: string }; media: WeekLeagueMedia; caption?: boolean }) {
  const images = media.teamImages[String(team.id)] ?? [];
  const [failed, setFailed] = useState<string[]>([]);
  const available = images.filter((image) => !failed.includes(image.imageUrl));
  const selected = available[0];
  const shown = selected?.kind === "portrait" ? available.filter((image) => image.kind === "portrait").slice(0, 2) : selected ? [selected] : [];
  const owners = media.owners[String(team.id)] ?? [];
  const names = owners.map((owner) => owner.name).join(" & ");
  return <figure className={`league-team-image${selected ? ` league-image-${selected.kind}` : " league-image-initials"}`}>
    {selected ? <span className="league-image-set">{shown.map((photo, index) => <IdentityPhoto key={`${photo.imageUrl}-${photo.memberId ?? index}`} photo={photo} teamName={team.name} onError={() => setFailed((current) => [...current, photo.imageUrl])} />)}</span> : <span className="league-image-lettering" aria-label={`${team.name}, team image unavailable`}>{team.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("")}</span>}
    {caption && names && <figcaption>{names}</figcaption>}
  </figure>;
}

export function ScoreLadder({ report, overview, media, selectedTeamId, onSelect }: { report: LeagueWeek; overview: WeekLeagueOverview; media: WeekLeagueMedia; selectedTeamId: number; onSelect: (id: number) => void }) {
  const [order, setOrder] = useState<"weekly" | "standings">("weekly");
  const selected = report.teams.find((team) => team.id === selectedTeamId);
  const canShowStandings = report.teams.every((team) => overview.teams[String(team.id)]?.standingRank != null);
  const teams = [...report.teams].sort((a, b) => order === "standings" ? (overview.teams[String(a.id)]?.standingRank ?? Infinity) - (overview.teams[String(b.id)]?.standingRank ?? Infinity) || b.score - a.score : b.score - a.score || a.name.localeCompare(b.name));
  const maximum = overview.aggregate.scale.max || Math.max(1, ...teams.map((team) => team.score));
  const median = overview.aggregate.median;
  const percentage = (score: number) => `${Math.max(0, Math.min(100, score / maximum * 100))}%`;
  return <aside className="league-ladder" aria-labelledby="league-ladder-title">
    <div className="league-ladder-heading"><h2 id="league-ladder-title">{order === "weekly" ? "This week's scoring" : "League standings"}</h2>{canShowStandings && <button type="button" onClick={() => setOrder((value) => value === "weekly" ? "standings" : "weekly")}>{order === "weekly" ? "Standings" : "Weekly order"}</button>}</div>
    <p className="league-ladder-note">{order === "weekly" ? `Week ${report.week} points` : `${overview.throughWeek == null ? "Season standings" : `Standings through Week ${overview.throughWeek}`}. Bars show Week ${report.week} points.`}{!report.complete && " · In progress"}</p>
    <div className="league-ladder-axis"><span>0</span>{median != null && <span style={{ left: percentage(median) }}>Median {points(median)}</span>}<span>{points(maximum)}</span></div>
    <div className="league-ladder-chart"><div className="league-ladder-guides" aria-hidden="true">{median != null && <i style={{ left: percentage(median) }} />}</div><ol className="league-ladder-list">
      {teams.map((team) => {
        const context = overview.teams[String(team.id)];
        const rank = order === "standings" ? context?.standingRank : context?.weeklyRank;
        const active = team.id === selectedTeamId;
        const opponent = team.id === selected?.opponentId;
        const tone = Math.abs(team.score - team.opponentScore) < .001 ? "tie" : team.score > team.opponentScore ? "win" : "loss";
        return <li key={team.id}><button type="button" className={`league-ladder-row league-ladder-${tone}${active ? " league-ladder-selected" : ""}${opponent ? " league-ladder-opponent" : ""}`} aria-pressed={active} onClick={() => onSelect(team.id)} aria-label={`${team.name}, ${rank ? `${ordinal(rank)} ${order === "weekly" ? "in scoring" : "in the standings"}, ` : ""}${points(team.score)} points${context?.record ? `, record ${context.record.label}` : ""}${opponent ? ", selected team's opponent" : ""}`}>
          <span className="league-ladder-rank">{rank ?? "–"}</span><TeamIdentityImage team={team} media={media} />
          <span className="league-ladder-name">{team.name}<small>{context?.record?.label ?? "Record unavailable"}{order === "standings" && context?.pointsFor != null && context?.pointsAgainst != null ? ` · PF ${points(context.pointsFor)} / PA ${points(context.pointsAgainst)}` : opponent ? " · Opponent" : active ? " · Selected" : ""}</small></span>
          <strong>{points(team.score)}</strong><span className="league-score-track" aria-hidden="true"><span style={{ width: percentage(team.score) }} /></span>
        </button></li>;
      })}
    </ol></div>
    {order === "standings" && <p className="league-table-source">{overview.standingsBasis}</p>}
  </aside>;
}

export function LeagueMatchups({ report, overview, media, selectedTeamId, onSelect }: { report: LeagueWeek; overview: WeekLeagueOverview; media: WeekLeagueMedia; selectedTeamId: number; onSelect: (id: number) => void }) {
  const maximum = overview.aggregate.scale.max || Math.max(1, ...report.teams.map((team) => team.score));
  const matchups = report.matchups.map((matchup) => ({ ...matchup, teams: [report.teams.find((team) => team.id === matchup.homeId), report.teams.find((team) => team.id === matchup.awayId)].filter((team): team is WeekTeam => !!team).sort((a, b) => b.score - a.score) })).filter((matchup) => matchup.teams.length === 2);
  return <section className="league-matchups" aria-labelledby="results-title">
    <div className="week-section-heading"><h2 id="results-title">Every matchup</h2><p>{overview.aggregate.completedMatchups} of {overview.aggregate.totalMatchups} final · Week {report.week}</p></div>
    <div className="league-matchup-list">{matchups.map((matchup) => {
      const [winner, loser] = matchup.teams;
      const difference = Math.abs(winner.score - loser.score);
      return <article key={matchup.id} className={`league-matchup${matchup.teams.some((team) => team.id === selectedTeamId) ? " league-matchup-selected" : ""}`} aria-label={`${winner.name} ${points(winner.score)}, ${loser.name} ${points(loser.score)}`}>
        {matchup.teams.map((team, index) => {
          const context = overview.teams[String(team.id)];
          const tone = difference < .001 ? "tie" : index === 0 ? "win" : "loss";
          const label = (matchup.final ? { tie: "Tie", win: "Win", loss: "Loss" } : { tie: "Tied", win: "Leading", loss: "Trailing" })[tone];
          return <button type="button" className={`league-matchup-team league-matchup-${tone}`} key={team.id} onClick={() => onSelect(team.id)} aria-pressed={team.id === selectedTeamId}>
            <TeamIdentityImage team={team} media={media} /><span className="league-matchup-identity"><strong>{team.name}</strong><small>{context?.record?.label ?? "Record unavailable"}{context?.weeklyRank ? ` · ${ordinal(context.weeklyRank)} in points` : ""}</small></span><span className="league-matchup-total">{points(team.score)}<small>{label}</small></span><span className="league-matchup-track" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, team.score / maximum * 100))}%` }} /></span>
          </button>;
        })}
        <p className="league-matchup-margin"><strong>{points(difference)}</strong><span>{difference < .001 ? "tied on points" : matchup.final ? "point margin" : "point lead"}</span></p>
      </article>;
    })}</div>
  </section>;
}
