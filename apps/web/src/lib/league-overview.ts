export type LeagueOverviewTeam = {
  id: number;
  record: { wins: number; losses: number; ties: number; label: string } | null;
  standingRank: number | null;
  division: { id: number; name: string; rank: number | null } | null;
  pointsFor: number | null;
  pointsAgainst: number | null;
  weeklyRank: number | null;
  weeklyRankTied: boolean;
  /** Signed final margin against this week's actual opponent. */
  margin: number | null;
};

export type WeekLeagueOverview = {
  season: number;
  week: number;
  currentWeek: number | null;
  throughWeek: number | null;
  final: boolean;
  teams: Record<string, LeagueOverviewTeam>;
  aggregate: {
    teamCount: number;
    completedMatchups: number;
    totalMatchups: number;
    high: { score: number; teamIds: number[] } | null;
    low: { score: number; teamIds: number[] } | null;
    median: number | null;
    /** Shared display domain for every team's weekly score, including zero. */
    scale: { min: number; max: number };
  };
  standingsBasis: "ESPN playoff seed" | null;
  recordsBasis: "ESPN records reconciled to completed matchups" | "Completed historical matchups" | null;
  sourceUrl: string | null;
  note: string;
};
