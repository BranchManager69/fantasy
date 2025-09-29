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
    <section className="scenario-drawer__section">
      <header>
        <h3>{title}</h3>
      </header>
      {items.length === 0 ? (
        <p className="scenario-drawer__empty">{emptyCopy}</p>
      ) : (
        <ul className="scenario-drawer__list">
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
    <article className="scenario-drawer__diff-card">
      <header>
        <span className="scenario-drawer__diff-week">Week {item.week}</span>
        <span className="scenario-drawer__diff-matchup">{item.home.teamName} vs {item.away.teamName}</span>
      </header>
      <div className="scenario-drawer__diff-grid">
        <div>
          <span className="scenario-drawer__diff-label">Baseline</span>
          <span className="scenario-drawer__diff-value">
            {formatScore(item.home.baselineScore)} – {formatScore(item.away.baselineScore)}
          </span>
          {baselineWinner ? <span className="scenario-drawer__diff-note">{baselineWinner}</span> : null}
        </div>
        <div>
          <span className="scenario-drawer__diff-label">Scenario</span>
          <span className="scenario-drawer__diff-value scenario-drawer__diff-value--accent">
            {formatScore(item.home.scenarioScore)} – {formatScore(item.away.scenarioScore)}
          </span>
          {scenarioWinner ? <span className="scenario-drawer__diff-note">{scenarioWinner}</span> : null}
        </div>
        <div className="scenario-drawer__diff-delta">
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
    <article className="scenario-drawer__diff-card">
      <header>
        <span className="scenario-drawer__diff-week">Week {item.week}</span>
        <span className="scenario-drawer__diff-matchup">{item.home.teamName} vs {item.away.teamName}</span>
      </header>
      <div className="scenario-drawer__diff-grid">
        <div>
          <span className="scenario-drawer__diff-label">Baseline</span>
          <span className="scenario-drawer__diff-value">
            {formatScore(item.home.baselineScore)} – {formatScore(item.away.baselineScore)}
          </span>
        </div>
        <div>
          <span className="scenario-drawer__diff-label">Scenario</span>
          <span className="scenario-drawer__diff-value scenario-drawer__diff-value--accent">
            {formatScore(item.home.scenarioScore)} – {formatScore(item.away.scenarioScore)}
          </span>
        </div>
        <div className="scenario-drawer__diff-delta">
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
    <section className="scenario-drawer">
      <header className="scenario-drawer__header">
        <div>
          <span className="scenario-drawer__eyebrow">Scenario</span>
          <h2>{scenarioLabel}</h2>
          {activeScenario.description ? <p className="scenario-drawer__description">{activeScenario.description}</p> : null}
        </div>
        <div className="scenario-drawer__meta">
          <span>Season {season}</span>
          <span>{overrides.completedWeeks.length} completed-week overrides</span>
          <span>{overrides.projectionWeeks.length} projection overrides</span>
          {detail?.simulationGeneratedAt ? (
            <span>Sim generated {formatTimestamp(detail.simulationGeneratedAt)}</span>
          ) : null}
          {hasOverlay && detail?.scenario.updatedAt ? (
            <span>Edited {formatTimestamp(detail.scenario.updatedAt)}</span>
          ) : null}
        </div>
      </header>

      {loading ? <p className="scenario-drawer__status">Loading scenario details…</p> : null}
      {error ? <p className="scenario-drawer__status scenario-drawer__status--error">{error}</p> : null}

      {!loading && !error && detail ? (
        <div className="scenario-drawer__body">
          {activeScenario.id === BASELINE_SCENARIO_ID ? (
            <p className="scenario-drawer__empty">Baseline dataset – no overlays applied.</p>
          ) : null}

          {!detail.hasSimulation && activeScenario.id !== BASELINE_SCENARIO_ID ? (
            <div className="scenario-drawer__callout">
              <strong>Simulation not yet generated.</strong>
              <span>Run <code>poetry run fantasy sim rest-of-season --season {season} --scenario {activeScenario.id}</code> to view diffs.</span>
            </div>
          ) : null}

          <div className="scenario-drawer__chips">
            <span className="scenario-drawer__chip">Completed overrides: {completedOverrideCount}</span>
            <span className="scenario-drawer__chip">Projection overrides: {projectionOverrideCount}</span>
            <span className="scenario-drawer__chip">Dataset: {detail.hasSimulation && detail.simulationGeneratedAt ? formatTimestamp(detail.simulationGeneratedAt) : "Not generated"}</span>
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
