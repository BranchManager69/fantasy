"use client";

import clsx from "clsx";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
} from "react";

import {
  probabilityLabel,
  formatMargin,
  formatFinalMargin,
  formatLiveMargin,
} from "@/lib/formatters";
import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";
import type {
  MatchupDetailResponse,
  MatchupPlayerLine,
  MatchupTeamSnapshot,
  TeamTimelineEntry,
} from "@/types/matchup-detail";

const PLAYER_SLOT_CLASS =
  "text-[0.78rem] font-semibold uppercase tracking-[0.12em] text-[var(--accent)]";
const PLAYER_NAME_CLASS = "text-[0.92rem] text-[var(--text-soft)]";
const PLAYER_POINTS_CLASS = "text-sm text-[var(--text-muted)]";

const CARD_TONE_STYLES: Record<TeamTimelineEntry["tone"], CSSProperties> = {
  favorable: {
    borderColor: "rgba(34, 197, 94, 0.4)",
    boxShadow: "0 16px 40px rgba(34, 197, 94, 0.12)",
  },
  coinflip: {
    borderColor: "rgba(96, 165, 250, 0.35)",
    boxShadow: "0 16px 40px rgba(96, 165, 250, 0.12)",
  },
  underdog: {
    borderColor: "rgba(249, 115, 22, 0.4)",
    boxShadow: "0 16px 40px rgba(249, 115, 22, 0.12)",
  },
};

const LIVE_CARD_STYLE: CSSProperties = {
  borderColor: "rgba(37, 99, 235, 0.35)",
  background: "linear-gradient(145deg, rgba(30, 64, 175, 0.18), rgba(10, 17, 30, 0.86))",
};

const STATUS_COLOR: Record<TeamTimelineEntry["status"], string> = {
  final: "text-[var(--text-soft)]",
  live: "text-[rgba(191,219,254,0.9)]",
  upcoming: "text-[var(--accent)]",
  future: "text-[rgba(148,163,184,0.7)]",
};

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
    <div className="space-y-3">
      <h4 className="text-base font-semibold text-[var(--text-soft)]">{title}</h4>
      <ul className="grid gap-2" role="list">
        {players.length === 0 ? (
          <li className="text-sm text-[var(--text-muted)]">No players listed.</li>
        ) : (
          players.map((player) => (
            <li
              key={`${player.playerName}-${player.lineupSlot}-${player.espnPlayerId ?? "na"}`}
              className="grid grid-cols-[60px,1fr,auto] items-center gap-3 rounded-[10px] border border-[rgba(255,255,255,0.06)] bg-[rgba(9,15,28,0.65)] px-3 py-2 text-[0.95rem]"
            >
              <span className={PLAYER_SLOT_CLASS}>{player.lineupSlot}</span>
              <span className={PLAYER_NAME_CLASS}>{player.playerName}</span>
              <span className={PLAYER_POINTS_CLASS}>{player.points.toFixed(1)} pts</span>
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
    <div className="grid gap-5 rounded-[var(--radius-md)] border border-[rgba(148,163,184,0.2)] bg-[rgba(8,14,28,0.75)] p-5">
      <header className="flex items-baseline justify-between gap-3 text-sm text-[var(--text-muted)]">
        <h3 className="text-base font-semibold text-[var(--text-soft)]">{snapshot.summary.name}</h3>
        <span>{label}</span>
      </header>
      {players ? (
        <div className="grid gap-4">
          <PlayerList title="Starters" players={players.starters} />
          <PlayerList title="Bench" players={players.bench} />
        </div>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">Lineup unavailable.</p>
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
    <section className="grid gap-5">
      <header className="flex items-baseline justify-between gap-3 text-sm text-[var(--text-muted)]">
        <h2 className="text-lg font-semibold text-[var(--text-soft)]">Season Timeline</h2>
      </header>
      <ol className="grid gap-4" role="list">
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
          const style: CSSProperties = {
            ...CARD_TONE_STYLES[entry.tone],
            ...(entry.status === "live" ? LIVE_CARD_STYLE : {}),
          };
          const isActive = activeMatchupId === entry.matchupId;

          return (
            <li key={`${entry.week}-${entry.matchupId}`}>
              <div
                className={clsx(
                  "rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(10,17,30,0.78)] p-5 shadow-sm transition-transform duration-150 hover:-translate-y-0.5",
                  isActive && "ring-2 ring-[rgba(96,165,250,0.4)]",
                )}
                style={style}
              >
                <button
                  type="button"
                  className="grid gap-3 text-left"
                  onClick={() => setSelected(entry)}
                >
                  <header className="flex items-baseline justify-between gap-3">
                    <div className="flex items-baseline gap-3">
                      <span className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Week {entry.week}</span>
                      <strong className="text-sm text-[var(--text-soft)]">{entry.isHome ? "Home" : "Away"}</strong>
                    </div>
                    <span className={clsx("text-xs uppercase tracking-[0.14em]", STATUS_COLOR[entry.status])}>{statusLabel}</span>
                  </header>
                  <h3 className="text-lg font-semibold text-[var(--text-soft)]">
                    {entry.isHome ? "vs" : "@"}{" "}
                    {entry.opponent.name}
                  </h3>
                  <p className="text-[1.1rem] font-semibold text-[var(--text-soft)]">
                    {scoreFor} – {scoreAgainst}
                  </p>
                  <p className="text-sm text-[var(--text-muted)]">{marginCopy}</p>
                  <footer className="flex flex-wrap gap-3 text-sm text-[var(--text-muted)]">
                    <span>Record: {recordCopy}</span>
                    {winProbCopy ? <span>{winProbCopy}</span> : null}
                  </footer>
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {selected ? (
        <div
          className="fixed inset-0 z-[1000] grid place-items-center bg-[rgba(3,6,16,0.72)] p-6 backdrop-blur-lg"
          role="presentation"
          onClick={closeDialog}
        >
          <div
            className="grid max-h-[90vh] w-full max-w-[min(960px,90vw)] gap-6 overflow-y-auto rounded-[var(--radius-lg)] border border-[rgba(148,163,184,0.25)] bg-[rgba(10,20,36,0.96)] p-7 shadow-[0_32px_120px_rgba(0,0,0,0.5)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="matchup-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-center justify-between gap-4">
              <div className="space-y-2">
                <span className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Week {selected.week}</span>
                <h3 className="text-lg font-semibold text-[var(--text-soft)]" id="matchup-dialog-title">
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
              <button
                type="button"
                className="rounded-full border border-[rgba(148,163,184,0.35)] px-4 py-1.5 text-sm text-[var(--text-soft)] transition hover:border-[rgba(96,165,250,0.6)]"
                onClick={closeDialog}
              >
                Close
              </button>
            </header>

            {state.loading ? <p className="text-sm text-[var(--text-muted)]">Loading matchup…</p> : null}
            {state.error ? <p className="text-sm text-[#fca5a5]">{state.error}</p> : null}

            {detail && !state.loading ? (
              <div className="grid gap-6">
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
                  {[
                    {
                      label: "Status",
                      value:
                        detail.status === "final"
                          ? "Final"
                          : detail.status === "in_progress"
                            ? "Live"
                            : "Projected",
                    },
                    {
                      label: detail.status === "in_progress" ? "Score" : "Final",
                      value:
                        detail.home.finalPoints !== null && detail.away.finalPoints !== null
                          ? `${detail.home.finalPoints.toFixed(1)} – ${detail.away.finalPoints.toFixed(1)}`
                          : "—",
                    },
                    {
                      label: "Projection",
                      value:
                        detail.home.projectedPoints !== null && detail.away.projectedPoints !== null
                          ? `${detail.home.projectedPoints.toFixed(1)} – ${detail.away.projectedPoints.toFixed(1)}`
                          : "—",
                    },
                    {
                      label: "Win Prob",
                      value:
                        detail.winProbabilities.home !== null || detail.winProbabilities.away !== null
                          ? `${detail.winProbabilities.home !== null ? Math.round(detail.winProbabilities.home * 100) : "—"}%` +
                            (detail.winProbabilities.away !== null
                              ? ` / ${Math.round(detail.winProbabilities.away * 100)}%`
                              : "")
                          : "—",
                    },
                  ].map(({ label, value }) => (
                    <div
                      key={label}
                      className="grid gap-1 rounded-[var(--radius-sm)] border border-[rgba(148,163,184,0.2)] bg-[rgba(13,23,44,0.68)] px-[14px] py-3"
                    >
                      <span className="text-[0.72rem] uppercase tracking-[0.16em] text-[var(--text-muted)]">{label}</span>
                      <span className="text-[1rem] font-semibold text-[var(--text-soft)]">{value}</span>
                    </div>
                  ))}
                </div>

                <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
                  <TeamColumn
                    label={
                      detail.status === "final"
                        ? "Final lineup"
                        : detail.status === "in_progress"
                          ? "Live lineup"
                          : "Projected lineup"
                    }
                    snapshot={detail.home}
                    players={
                      detail.status !== "upcoming" && hasActual
                        ? detail.home.players.actual
                        : detail.home.players.projected
                    }
                  />
                  <TeamColumn
                    label={
                      detail.status === "final"
                        ? "Final lineup"
                        : detail.status === "in_progress"
                          ? "Live lineup"
                          : "Projected lineup"
                    }
                    snapshot={detail.away}
                    players={
                      detail.status !== "upcoming" && hasActual
                        ? detail.away.players.actual
                        : detail.away.players.projected
                    }
                  />
                </div>

                {detail.status !== "upcoming" && detail.home.players.projected && detail.away.players.projected ? (
                  <div className="grid gap-4">
                    <h4 className="text-base font-semibold text-[var(--text-soft)]">Pre-game projections</h4>
                    <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
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
