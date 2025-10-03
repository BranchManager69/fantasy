import type { MonteCarloSummary } from "@/lib/simulator-data";
import { RefreshControls } from "@/components/refresh-controls";
import { ScenarioSwitcher } from "@/components/scenario-switcher";
import type { ScenarioOption } from "@/types/scenario";

export type SimulationHeaderProps = {
  season: number;
  firstWeek: number;
  lastWeek: number;
  weeksCount: number;
  teamCount: number;
  monteCarlo: MonteCarloSummary | undefined | null;
  generatedAt: string | null;
  scenarios: ScenarioOption[];
  activeScenarioId: string;
};

export function SimulationHeader({
  season,
  firstWeek,
  lastWeek,
  weeksCount,
  teamCount,
  monteCarlo,
  generatedAt,
  scenarios,
  activeScenarioId,
}: SimulationHeaderProps) {
  return (
    <header className="matrix-header">
      <div className="matrix-header__left">
        <h1>Season {season} · Weeks {firstWeek}–{lastWeek}</h1>
        <span>{weeksCount} weeks · {teamCount} teams</span>
      </div>
      {monteCarlo ? (
        <div className="matrix-header__stats">
          <span>{monteCarlo.iterations.toLocaleString()} Monte Carlo runs</span>
          <span>{monteCarlo.playoff_slots} playoff slots</span>
          {monteCarlo.random_seed !== null ? <span>Seed {monteCarlo.random_seed}</span> : null}
        </div>
      ) : null}
      <div className="matrix-header__actions">
        <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenarioId} />
        <RefreshControls initialGeneratedAt={generatedAt} scenarioId={activeScenarioId} />
      </div>
    </header>
  );
}
