export type ScenarioOption = {
  id: string;
  label: string;
  description: string | null;
  season: number;
  isBaseline: boolean;
  updatedAt: string | null;
  overrides: {
    completedWeeks: number[];
    projectionWeeks: number[];
  };
};

export type ScenarioListResponse = {
  season: number;
  items: ScenarioOption[];
};

export type ScenarioOverlayEntry = {
  team_id: number | null;
  player_name: string | null;
  lineup_slot: string | null;
  espn_player_id: number | null;
  espn_position: string | null;
  counts_for_score: boolean;
  score_total?: number | null;
  projected_points?: number | null;
  score_base?: number | null;
  score_bonus?: number | null;
  score_position?: number | null;
};

export type ScenarioOverlay = {
  scenario_id: string;
  season: number;
  label: string | null;
  description: string | null;
  updated_at: string | null;
  completed_weeks: Record<string, unknown> | null;
  projection_weeks: Record<string, unknown> | null;
};

export type ScenarioDiffSide = {
  teamId: number;
  teamName: string;
  baselineScore: number | null;
  scenarioScore: number | null;
  delta: number | null;
};

export type CompletedWeekDiff = {
  week: number;
  matchupId: string;
  home: ScenarioDiffSide;
  away: ScenarioDiffSide;
  winner: {
    baseline: "home" | "away" | "tie" | null;
    scenario: "home" | "away" | "tie" | null;
  };
};

export type ProjectionWeekDiffEntry = {
  week: number;
  matchupId: string;
  home: ScenarioDiffSide;
  away: ScenarioDiffSide;
};

export type ScenarioDiffSummary = {
  completedWeeks: CompletedWeekDiff[];
  projectionWeeks: ProjectionWeekDiffEntry[];
};

export type ScenarioDetailResponse = {
  scenario: ScenarioOption;
  overlay: ScenarioOverlay | null;
  hasSimulation: boolean;
  simulationGeneratedAt: string | null;
  diff: ScenarioDiffSummary;
};
