"use client";

import { useEffect, useMemo, useState } from "react";

import { formatTimestamp } from "@/lib/formatters";

const POLL_INTERVAL_MS = 20_000;

export type LiveDiffTeamDelta = {
  teamId?: number | null;
  abbrev?: string | null;
  name?: string | null;
  previousTotal?: number | null;
  currentTotal?: number | null;
  delta: number;
};

export type LiveDiffPlayerDelta = {
  teamId?: number | null;
  abbrev?: string | null;
  playerName: string;
  lineupSlot?: string | null;
  previousScore?: number | null;
  currentScore?: number | null;
  delta: number;
  countsForScore?: boolean;
};

export type LiveDiffEntry = {
  finishedAt: string;
  season?: number | null;
  week?: number | null;
  message?: string | null;
  teamDiffs: LiveDiffTeamDelta[];
  playerDiffs: LiveDiffPlayerDelta[];
  headlineTeams?: string[];
  headlinePlayers?: string[];
  hasChanges: boolean;
};

type Props = {
  scenarioId: string;
};

async function fetchDiffEntries(signal: AbortSignal): Promise<LiveDiffEntry[]> {
  const response = await fetch(`/api/sim/rest-of-season/diff?limit=8`, {
    method: "GET",
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Diff request failed (${response.status})`);
  }

  const payload = (await response.json()) as { items: LiveDiffEntry[] };
  return payload.items ?? [];
}

function formatDelta(delta: number): string {
  const rounded = Math.abs(delta).toFixed(Math.abs(delta) >= 10 ? 0 : 1);
  return `${delta >= 0 ? "+" : "-"}${rounded}`;
}

export function LiveActivityFeed({ scenarioId }: Props) {
  const isBaseline = scenarioId.toLowerCase() === "baseline";
  const [entries, setEntries] = useState<LiveDiffEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isBaseline) {
      setEntries([]);
      setError(null);
      return () => {};
    }

    let mounted = true;
    const controller = new AbortController();

    const load = async () => {
      try {
        const data = await fetchDiffEntries(controller.signal);
        if (!mounted) return;
        setEntries(data);
        setError(null);
      } catch (err) {
        if (!mounted) return;
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        setError(err instanceof Error ? err.message : "Unable to load updates");
      }
    };

    load();
    const interval = setInterval(() => {
      load();
    }, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [isBaseline, scenarioId]);

  if (!isBaseline) {
    return (
      <section className="live-feed">
        <header className="live-feed__header">Live scoring</header>
        <div className="live-feed__body">
          <p className="live-feed__status">Live updates available on the baseline dataset.</p>
        </div>
      </section>
    );
  }

  const displayEntries = useMemo(() => {
    if (!entries.length) return [] as LiveDiffEntry[];
    return entries.filter((entry) => entry.hasChanges).slice(0, 5);
  }, [entries]);

  if (error) {
    return (
      <section className="live-feed live-feed--error">
        <header className="live-feed__header">Live scoring</header>
        <div className="live-feed__body">
          <p className="live-feed__status">{error}</p>
        </div>
      </section>
    );
  }

  if (!displayEntries.length) {
    const latest = entries[0];
    return (
      <section className="live-feed">
        <header className="live-feed__header">Live scoring</header>
        <div className="live-feed__body">
          <p className="live-feed__status">
            {latest ? `Last checked ${formatTimestamp(latest.finishedAt)}` : "Waiting for scoring updates"}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="live-feed">
      <header className="live-feed__header">Live scoring</header>
      <ul className="live-feed__list">
        {displayEntries.map((entry) => {
          const timestamp = formatTimestamp(entry.finishedAt);
          const weekCopy = entry.week ? `Week ${entry.week}` : null;
          const headlineTeams = entry.headlineTeams?.length ? entry.headlineTeams : null;
          const headlinePlayers = entry.headlinePlayers?.length ? entry.headlinePlayers : null;
          return (
            <li key={entry.finishedAt} className="live-feed__item">
              <div className="live-feed__meta">
                <span className="live-feed__time">{timestamp}</span>
                {weekCopy ? <span className="live-feed__week">{weekCopy}</span> : null}
              </div>
              {headlineTeams ? (
                <p className="live-feed__headline">{headlineTeams.join(", ")}</p>
              ) : null}
              {headlinePlayers ? (
                <p className="live-feed__headline live-feed__headline--secondary">
                  {headlinePlayers.join(", ")}
                </p>
              ) : null}
              <div className="live-feed__diffs">
                {entry.teamDiffs.slice(0, 3).map((diff, index) => (
                  <span key={`team-${index}`} className="live-feed__diff live-feed__diff--team">
                    <strong>{diff.abbrev || diff.name || `Team ${diff.teamId ?? ""}`}</strong>
                    {` `}
                    <span className={diff.delta >= 0 ? "delta delta--up" : "delta delta--down"}>
                      {formatDelta(diff.delta)}
                    </span>
                    {diff.currentTotal !== undefined && diff.currentTotal !== null
                      ? ` (→ ${diff.currentTotal.toFixed(1)})`
                      : null}
                  </span>
                ))}
                {entry.playerDiffs.slice(0, 4).map((diff, index) => (
                  <span key={`player-${index}`} className="live-feed__diff live-feed__diff--player">
                    <strong>{diff.playerName}</strong>
                    {diff.abbrev ? ` (${diff.abbrev}${diff.lineupSlot ? ` ${diff.lineupSlot}` : ""})` : ""}
                    {` `}
                    <span className={diff.delta >= 0 ? "delta delta--up" : "delta delta--down"}>
                      {formatDelta(diff.delta)}
                    </span>
                    {diff.currentScore !== undefined && diff.currentScore !== null
                      ? ` (→ ${diff.currentScore.toFixed(1)})`
                      : null}
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
