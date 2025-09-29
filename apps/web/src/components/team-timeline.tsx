"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { probabilityLabel, formatMargin, formatFinalMargin, formatLiveMargin } from "@/lib/formatters";
import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";
import type {
  MatchupDetailResponse,
  MatchupPlayerLine,
  MatchupTeamSnapshot,
  TeamTimelineEntry,
} from "@/types/matchup-detail";

function formatRecord(record: { wins: number; losses: number; ties: number }): string {
  const base = `${record.wins}-${record.losses}`;
  return record.ties > 0 ? `${base}-${record.ties}` : base;
}

function formatScore(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return value.toFixed(1);
}

type Props = {
  entries: TeamTimelineEntry[];
  season: number;
  scenarioId: string;
};

type FetchState = {
  loading: boolean;
  error: string | null;
  detail: MatchupDetailResponse | null;
};

const INITIAL_FETCH_STATE: FetchState = {
  loading: false,
  error: null,
  detail: null,
};

function describeStatus(entry: TeamTimelineEntry): string {
  if (entry.status === "final") {
    if (!entry.result) return "Final";
    if (entry.result === "win") return "Win";
    if (entry.result === "loss") return "Loss";
    return "Tie";
  }
  if (entry.status === "live") return "Live";
  if (entry.status === "upcoming") return "Next";
  return "Projected";
}

function PlayerList({
  title,
  players,
}: {
  title: string;
  players: MatchupPlayerLine[];
}) {
  return (
    <div>
      <h4>{title}</h4>
      <ul className="team-timeline__player-list">
        {players.length === 0 ? (
          <li className="team-timeline__player-empty">No players listed.</li>
        ) : (
          players.map((player) => (
            <li key={`${player.playerName}-${player.lineupSlot}-${player.espnPlayerId ?? "na"}`}>
              <span className="player-slot">{player.lineupSlot}</span>
              <span className="player-name">{player.playerName}</span>
              <span className="player-points">{player.points.toFixed(1)} pts</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function TeamColumn({
  label,
  snapshot,
  players,
}: {
  label: string;
  snapshot: MatchupTeamSnapshot;
  players: {
    starters: MatchupPlayerLine[];
    bench: MatchupPlayerLine[];
  } | null;
}) {
  return (
    <div className="team-timeline__dialog-column">
      <header>
        <h3>{snapshot.summary.name}</h3>
        <span>{label}</span>
      </header>
      {players ? (
        <div className="team-timeline__player-groups">
          <PlayerList title="Starters" players={players.starters} />
          <PlayerList title="Bench" players={players.bench} />
        </div>
      ) : (
        <p className="team-timeline__player-empty">Lineup unavailable.</p>
      )}
    </div>
  );
}

export function TeamTimeline({ entries, season, scenarioId }: Props) {
  const [selected, setSelected] = useState<TeamTimelineEntry | null>(null);
  const [state, setState] = useState<FetchState>(INITIAL_FETCH_STATE);

  useEffect(() => {
    if (!selected) {
      setState(INITIAL_FETCH_STATE);
      return;
    }

    const controller = new AbortController();
    const fetchDetail = async () => {
      setState({ loading: true, detail: null, error: null });
      try {
        const params = new URLSearchParams({
          season: String(season),
          matchupId: selected.matchupId,
        });
        if (scenarioId && scenarioId !== BASELINE_SCENARIO_ID) {
          params.set("scenario", scenarioId);
        }
        const response = await fetch(`/api/matchup/detail?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
          throw new Error(payload.error ?? `Request failed (${response.status})`);
        }
        const payload = (await response.json()) as MatchupDetailResponse;
        setState({ loading: false, detail: payload, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Unable to load matchup";
        setState({ loading: false, detail: null, error: message });
      }
    };

    fetchDetail();
    return () => controller.abort();
  }, [season, scenarioId, selected]);

  const closeDialog = useCallback(() => {
    setSelected(null);
  }, []);

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, closeDialog]);

  const activeMatchupId = selected?.matchupId ?? null;

  const detail = state.detail;
  const hasActual = detail?.home.players.actual && detail?.away.players.actual;

  return (
    <section className="team-timeline">
      <header>
        <h2>Season Timeline</h2>
      </header>
      <ol className="team-timeline__list">
    {entries.map((entry) => {
          const recordCopy = formatRecord(entry.record);
          const statusLabel = describeStatus(entry);
          const winProbCopy = entry.status !== "final" ? probabilityLabel(entry.winProbability) : null;
          const scoreFor = entry.actualScore ? formatScore(entry.actualScore.for) : formatScore(entry.projectedScore.for);
          const scoreAgainst = entry.actualScore
            ? formatScore(entry.actualScore.against)
            : formatScore(entry.projectedScore.against);
          const marginCopy = entry.status === "final"
            ? formatFinalMargin(entry.margin ?? 0)
            : entry.status === "live"
              ? formatLiveMargin(entry.actualScore?.for ?? null, entry.actualScore?.against ?? null)
              : formatMargin(entry.margin ?? 0);
          const toneClass = `probability-glow--${entry.tone}`;
          const isActive = activeMatchupId === entry.matchupId;

          return (
            <li
              key={`${entry.week}-${entry.matchupId}`}
              className={`team-timeline__card ${toneClass} team-timeline__card--${entry.status}${isActive ? " team-timeline__card--active" : ""}`}
            >
              <button
                type="button"
                className="team-timeline__card-button"
                onClick={() => setSelected(entry)}
              >
                <header>
                  <div>
                    <span className="team-timeline__week">Week {entry.week}</span>
                    <strong>{entry.isHome ? "Home" : "Away"}</strong>
                  </div>
                  <span className={`team-timeline__status team-timeline__status--${entry.status}`}>{statusLabel}</span>
                </header>
                <h3>
                  {entry.isHome ? "vs" : "@"}{" "}
                  {entry.opponent.name}
                </h3>
                <p className="team-timeline__score">
                  {scoreFor} – {scoreAgainst}
                </p>
                <p className="team-timeline__meta">{marginCopy}</p>
                <footer>
                  <span>Record: {recordCopy}</span>
                  {winProbCopy ? <span>{winProbCopy}</span> : null}
                </footer>
              </button>
            </li>
          );
        })}
      </ol>

      {selected ? (
        <div className="team-timeline__dialog-backdrop" role="presentation" onClick={closeDialog}>
          <div
            className="team-timeline__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="matchup-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="team-timeline__dialog-header">
              <div>
                <span className="team-timeline__dialog-eyebrow">Week {selected.week}</span>
                <h3 id="matchup-dialog-title">
                  {detail ? (
                    <>
                      <Link href={`/teams/${detail.home.summary.teamId}`}>{detail.home.summary.name}</Link>
                      {" vs "}
                      <Link href={`/teams/${detail.away.summary.teamId}`}>{detail.away.summary.name}</Link>
                    </>
                  ) : (
                    `${selected.isHome ? "vs" : "@"} ${selected.opponent.name}`
                  )}
                </h3>
              </div>
              <button type="button" className="team-timeline__dialog-close" onClick={closeDialog}>
                Close
              </button>
            </header>

            {state.loading ? <p className="team-timeline__dialog-status">Loading matchup…</p> : null}
            {state.error ? <p className="team-timeline__dialog-status team-timeline__dialog-status--error">{state.error}</p> : null}

            {detail && !state.loading ? (
              <div className="team-timeline__dialog-body">
                <div className="team-timeline__dialog-summary">
                  <div>
                    <span className="team-timeline__dialog-stat-label">Status</span>
                    <span className="team-timeline__dialog-stat-value">
                      {detail.status === "final"
                        ? "Final"
                        : detail.status === "in_progress"
                          ? "Live"
                          : "Projected"}
                    </span>
                  </div>
                  <div>
                    <span className="team-timeline__dialog-stat-label">
                      {detail.status === "in_progress" ? "Score" : "Final"}
                    </span>
                    <span className="team-timeline__dialog-stat-value">
                      {detail.home.finalPoints !== null && detail.away.finalPoints !== null
                        ? `${detail.home.finalPoints.toFixed(1)} – ${detail.away.finalPoints.toFixed(1)}`
                        : "—"}
                    </span>
                  </div>
                  <div>
                    <span className="team-timeline__dialog-stat-label">Projection</span>
                    <span className="team-timeline__dialog-stat-value">
                      {detail.home.projectedPoints !== null && detail.away.projectedPoints !== null
                        ? `${detail.home.projectedPoints.toFixed(1)} – ${detail.away.projectedPoints.toFixed(1)}`
                        : "—"}
                    </span>
                  </div>
                  <div>
                    <span className="team-timeline__dialog-stat-label">Win Prob</span>
                    <span className="team-timeline__dialog-stat-value">
                      {detail.winProbabilities.home !== null
                        ? `${Math.round(detail.winProbabilities.home * 100)}%`
                        : "—"}
                      {detail.winProbabilities.away !== null
                        ? ` / ${Math.round(detail.winProbabilities.away * 100)}%`
                        : null}
                    </span>
                  </div>
                </div>

                <div className="team-timeline__dialog-grid">
                  <TeamColumn
                    label={detail.status === "final" ? "Final lineup" : detail.status === "in_progress" ? "Live lineup" : "Projected lineup"}
                    snapshot={detail.home}
                    players={
                      detail.status !== "upcoming" && hasActual
                        ? detail.home.players.actual
                        : detail.home.players.projected
                    }
                  />
                  <TeamColumn
                    label={detail.status === "final" ? "Final lineup" : detail.status === "in_progress" ? "Live lineup" : "Projected lineup"}
                    snapshot={detail.away}
                    players={
                      detail.status !== "upcoming" && hasActual
                        ? detail.away.players.actual
                        : detail.away.players.projected
                    }
                  />
                </div>

                {detail.status !== "upcoming" && detail.home.players.projected && detail.away.players.projected ? (
                  <div className="team-timeline__dialog-secondary">
                    <h4>Pre-game projections</h4>
                    <div className="team-timeline__dialog-grid">
                      <TeamColumn label="Projected" snapshot={detail.home} players={detail.home.players.projected} />
                      <TeamColumn label="Projected" snapshot={detail.away} players={detail.away.players.projected} />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
