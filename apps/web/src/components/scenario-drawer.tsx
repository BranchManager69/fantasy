"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { formatTimestamp } from "@/lib/formatters";
import type {
  CompletedWeekDiff,
  ProjectionWeekDiffEntry,
  ScenarioDetailResponse,
  ScenarioOption,
} from "@/types/scenario";
import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";

type Props = {
  season: number;
  scenarios: ScenarioOption[];
  activeScenarioId: string;
};

type FetchState = {
  loading: boolean;
  error: string | null;
  detail: ScenarioDetailResponse | null;
};

const INITIAL_STATE: FetchState = {
  loading: false,
  error: null,
  detail: null,
};

function formatScore(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return value.toFixed(1);
}

function formatDelta(delta: number | null): string | null {
  if (delta === null || Number.isNaN(delta)) return null;
  if (Math.abs(delta) < 0.05) return null;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}`;
}

function winnerLabel(value: "home" | "away" | "tie" | null, homeName: string, awayName: string): string {
  if (!value) return "";
  if (value === "home") return `${homeName} win`;
  if (value === "away") return `${awayName} win`;
  return "Tie";
}

function DiffList<T extends CompletedWeekDiff | ProjectionWeekDiffEntry>({
  title,
  emptyCopy,
  items,
  render,
}: {
  title: string;
  emptyCopy: string;
  items: T[];
  render: (item: T) => ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <h3 className="text-lg font-semibold text-[var(--text-soft)]">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{emptyCopy}</p>
      ) : (
        <ul className="grid gap-3" role="list">
          {items.map((item) => (
            <li key={`${item.week}-${item.matchupId}`}>{render(item)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function renderCompletedDiff(item: CompletedWeekDiff) {
  const baselineWinner = winnerLabel(item.winner.baseline, item.home.teamName, item.away.teamName);
  const scenarioWinner = winnerLabel(item.winner.scenario, item.home.teamName, item.away.teamName);
  const homeDelta = formatDelta(item.home.delta);
  const awayDelta = formatDelta(item.away.delta);

  return (
    <article className="grid gap-4 rounded-[var(--radius-md)] border border-[rgba(148,163,184,0.2)] bg-[rgba(13,23,44,0.72)] p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3 text-sm text-[var(--text-muted)]">
        <span className="text-xs uppercase tracking-[0.16em]">Week {item.week}</span>
        <span className="text-sm text-[var(--text-soft)]">{item.home.teamName} vs {item.away.teamName}</span>
      </header>
      <div className="grid gap-4 md:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
        <div className="grid gap-1">
          <span className="text-[0.72rem] uppercase tracking-[0.16em] text-[var(--text-muted)]">Baseline</span>
          <span className="text-[1rem] font-semibold text-[var(--text-soft)]">
            {formatScore(item.home.baselineScore)} – {formatScore(item.away.baselineScore)}
          </span>
          {baselineWinner ? <span className="text-sm text-[var(--text-muted)]">{baselineWinner}</span> : null}
        </div>
        <div className="grid gap-1">
          <span className="text-[0.72rem] uppercase tracking-[0.16em] text-[var(--text-muted)]">Scenario</span>
          <span className="text-[1rem] font-semibold text-[var(--accent)]">
            {formatScore(item.home.scenarioScore)} – {formatScore(item.away.scenarioScore)}
          </span>
          {scenarioWinner ? <span className="text-sm text-[var(--text-muted)]">{scenarioWinner}</span> : null}
        </div>
        <div className="grid gap-1 text-sm text-[var(--text-muted)]">
          {homeDelta ? <span>{item.home.teamName}: {homeDelta}</span> : null}
          {awayDelta ? <span>{item.away.teamName}: {awayDelta}</span> : null}
        </div>
      </div>
    </article>
  );
}

function renderProjectionDiff(item: ProjectionWeekDiffEntry) {
  const homeDelta = formatDelta(item.home.delta);
  const awayDelta = formatDelta(item.away.delta);

  return (
    <article className="grid gap-4 rounded-[var(--radius-md)] border border-[rgba(148,163,184,0.2)] bg-[rgba(13,23,44,0.72)] p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3 text-sm text-[var(--text-muted)]">
        <span className="text-xs uppercase tracking-[0.16em]">Week {item.week}</span>
        <span className="text-sm text-[var(--text-soft)]">{item.home.teamName} vs {item.away.teamName}</span>
      </header>
      <div className="grid gap-4 md:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
        <div className="grid gap-1">
          <span className="text-[0.72rem] uppercase tracking-[0.16em] text-[var(--text-muted)]">Baseline</span>
          <span className="text-[1rem] font-semibold text-[var(--text-soft)]">
            {formatScore(item.home.baselineScore)} – {formatScore(item.away.baselineScore)}
          </span>
        </div>
        <div className="grid gap-1">
          <span className="text-[0.72rem] uppercase tracking-[0.16em] text-[var(--text-muted)]">Scenario</span>
          <span className="text-[1rem] font-semibold text-[var(--accent)]">
            {formatScore(item.home.scenarioScore)} – {formatScore(item.away.scenarioScore)}
          </span>
        </div>
        <div className="grid gap-1 text-sm text-[var(--text-muted)]">
          {homeDelta ? <span>{item.home.teamName}: {homeDelta}</span> : null}
          {awayDelta ? <span>{item.away.teamName}: {awayDelta}</span> : null}
        </div>
      </div>
    </article>
  );
}

export function ScenarioDrawer({ season, scenarios, activeScenarioId }: Props) {
  const [state, setState] = useState<FetchState>(INITIAL_STATE);
  const activeScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === activeScenarioId) ?? scenarios[0] ?? null,
    [activeScenarioId, scenarios],
  );

  useEffect(() => {
    if (!activeScenario) {
      setState(INITIAL_STATE);
      return;
    }

    const controller = new AbortController();
    setState({ loading: true, error: null, detail: null });

    const fetchDetail = async () => {
      try {
        const params = new URLSearchParams({ season: String(season), id: activeScenario.id });
        const response = await fetch(`/api/scenario/detail?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
          throw new Error(payload.error ?? `Request failed (${response.status})`);
        }
        const payload = (await response.json()) as ScenarioDetailResponse;
        setState({ loading: false, error: null, detail: payload });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Unable to load scenario";
        setState({ loading: false, error: message, detail: null });
      }
    };

    fetchDetail();
    return () => controller.abort();
  }, [activeScenario, season]);

  if (!activeScenario) {
    return null;
  }

  const { loading, error, detail } = state;
  const hasOverlay = Boolean(detail?.overlay);
  const overrides = activeScenario.overrides;
  const scenarioLabel = activeScenario.label || activeScenario.id;
  const completedOverrideCount = detail?.diff.completedWeeks.length ?? overrides.completedWeeks.length;
  const projectionOverrideCount = detail?.diff.projectionWeeks.length ?? overrides.projectionWeeks.length;

  return (
    <section className="grid gap-6 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(15,24,45,0.7)] p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">Scenario</span>
          <h2 className="text-xl font-semibold text-[var(--text-soft)]">{scenarioLabel}</h2>
          {activeScenario.description ? (
            <p className="text-sm text-[var(--text-muted)]">{activeScenario.description}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-3 text-sm text-[var(--text-muted)]">
          <span>Season {season}</span>
          <span>{overrides.completedWeeks.length} completed overrides</span>
          <span>{overrides.projectionWeeks.length} projection overrides</span>
          {detail?.simulationGeneratedAt ? (
            <span>Sim {formatTimestamp(detail.simulationGeneratedAt)}</span>
          ) : null}
          {hasOverlay && detail?.scenario.updatedAt ? (
            <span>Edited {formatTimestamp(detail.scenario.updatedAt)}</span>
          ) : null}
        </div>
      </header>

      {loading ? <p className="text-sm text-[var(--text-muted)]">Loading scenario details…</p> : null}
      {error ? <p className="text-sm text-[#fca5a5]">{error}</p> : null}

      {!loading && !error && detail ? (
        <div className="grid gap-6">
          {activeScenario.id === BASELINE_SCENARIO_ID ? (
            <p className="text-sm text-[var(--text-muted)]">Baseline dataset – no overlays applied.</p>
          ) : null}

          {!detail.hasSimulation && activeScenario.id !== BASELINE_SCENARIO_ID ? (
            <div className="grid gap-2 rounded-[var(--radius-sm)] border border-[rgba(148,163,184,0.25)] bg-[rgba(10,18,32,0.78)] p-4 text-sm text-[var(--text-muted)]">
              <strong className="text-[var(--text-soft)]">Simulation not yet generated.</strong>
              <span>
                Run <code className="rounded bg-[rgba(15,24,45,0.9)] px-2 py-1 text-[var(--text-soft)]">poetry run fantasy sim rest-of-season --season {season} --scenario {activeScenario.id}</code> to
                view diffs.
              </span>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3 text-xs uppercase tracking-[0.14em] text-[var(--text-muted)]">
            <span className="rounded-full border border-[rgba(148,163,184,0.25)] bg-[rgba(10,18,32,0.6)] px-3 py-1">
              Completed overrides: {completedOverrideCount}
            </span>
            <span className="rounded-full border border-[rgba(148,163,184,0.25)] bg-[rgba(10,18,32,0.6)] px-3 py-1">
              Projection overrides: {projectionOverrideCount}
            </span>
            <span className="rounded-full border border-[rgba(148,163,184,0.25)] bg-[rgba(10,18,32,0.6)] px-3 py-1">
              Dataset: {detail.hasSimulation && detail.simulationGeneratedAt ? formatTimestamp(detail.simulationGeneratedAt) : "Not generated"}
            </span>
          </div>

          <DiffList
            title="Completed weeks"
            emptyCopy="No completed-week differences yet."
            items={detail.diff.completedWeeks}
            render={renderCompletedDiff}
          />

          <DiffList
            title="Projection updates"
            emptyCopy="No projection differences yet."
            items={detail.diff.projectionWeeks}
            render={renderProjectionDiff}
          />
        </div>
      ) : null}
    </section>
  );
}
