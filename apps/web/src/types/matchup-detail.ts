import type { ScenarioOption } from "@/types/scenario";

export type MatchupPlayerLine = {
  espnPlayerId: number | null;
  playerName: string;
  lineupSlot: string;
  position: string | null;
  points: number;
  scoreBase: number | null;
  scoreBonus: number | null;
  scorePosition: number | null;
  countsForScore: boolean;
};

export type MatchupTeamSummary = {
  teamId: number;
  name: string;
  abbrev: string | null;
  owners: string[];
  logoUrl: string | null;
};

export type MatchupTeamSnapshot = {
  summary: MatchupTeamSummary;
  projectedPoints: number | null;
  opponentProjectedPoints: number | null;
  finalPoints: number | null;
  players: {
    actual: {
      starters: MatchupPlayerLine[];
      bench: MatchupPlayerLine[];
    } | null;
    projected: {
      starters: MatchupPlayerLine[];
      bench: MatchupPlayerLine[];
    } | null;
  };
};

export type MatchupDetailResponse = {
  season: number;
  scenarioId: string;
  matchupId: string;
  week: number;
  status: "final" | "in_progress" | "upcoming";
  home: MatchupTeamSnapshot;
  away: MatchupTeamSnapshot;
  projectionMargin: number | null;
  finalMargin: number | null;
  winProbabilities: {
    home: number | null;
    away: number | null;
  };
};

export type TeamTimelineEntry = {
  week: number;
  matchupId: string;
  isHome: boolean;
  opponent: {
    teamId: number | null;
    name: string;
    abbrev: string | null;
  };
  status: "final" | "live" | "upcoming" | "future";
  result: "win" | "loss" | "tie" | null;
  record: {
    wins: number;
    losses: number;
    ties: number;
  };
  actualScore: {
    for: number | null;
    against: number | null;
  } | null;
  projectedScore: {
    for: number;
    against: number;
  };
  margin: number | null;
  winProbability: number;
  tone: "favorable" | "coinflip" | "underdog";
};

export type ScenarioAwareTimeline = {
  season: number;
  scenarioId: string;
  entries: TeamTimelineEntry[];
  scenario: ScenarioOption;
};
