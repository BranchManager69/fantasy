import type {
  MonteCarloTeamSummary,
  SimulationStanding,
  SimulationTeamMeta,
  TeamScheduleWithContext,
} from "@/lib/simulator-data";
import type { TeamLeagueMetrics } from "@/lib/team-metrics";

export type SimulationTeamContext = {
  team: SimulationTeamMeta;
  schedule: TeamScheduleWithContext[];
  metrics: TeamLeagueMetrics;
  standing: SimulationStanding | null;
  monteCarlo: MonteCarloTeamSummary | null;
};

export type HighlightCard = {
  id: string;
  eyebrow: string;
  heading: string;
  link?: string | null;
  value: string;
  meta?: string | null;
  secondary?: string | null;
  extra?: string | null;
};
