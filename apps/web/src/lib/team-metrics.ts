import type { TeamScheduleWithContext } from "@/lib/simulator-data";

export type TeamStreak = {
  type: "win" | "loss" | "tie";
  length: number;
};

export type TeamLeagueMetrics = {
  wins: number;
  losses: number;
  ties: number;
  gamesPlayed: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifferential: number;
  pointsPerGame: number | null;
  currentStreak: TeamStreak | null;
  nextGame: TeamScheduleWithContext | null;
  upcomingAvgWins: number | null;
  upcomingAvgPlayoffOdds: number | null;
};

function normaliseScore(value: number | null | undefined, fallback: number): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return value;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function computeStreak(completed: TeamScheduleWithContext[]): TeamStreak | null {
  for (let index = completed.length - 1; index >= 0; index -= 1) {
    const result = completed[index].result;
    if (!result) {
      continue;
    }

    let length = 1;
    for (let lookback = index - 1; lookback >= 0; lookback -= 1) {
      if (completed[lookback].result !== result) {
        break;
      }
      length += 1;
    }

    return { type: result, length };
  }
  return null;
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value - Math.round(value)) < 1e-9) {
    return String(Math.round(value));
  }
  return value.toFixed(1);
}

export function formatSimpleRecord(record: { wins: number; losses: number; ties?: number }): string {
  const wins = formatCount(record.wins);
  const losses = formatCount(record.losses);
  const base = `${wins} – ${losses}`;
  const ties = record.ties ?? 0;
  if (Math.abs(ties) < 1e-9) {
    return base;
  }
  return `${base} – ${formatCount(ties)}`;
}

export function betterRecord(a: TeamLeagueMetrics, b: TeamLeagueMetrics): boolean {
  if (a.wins !== b.wins) return a.wins > b.wins;
  if (a.losses !== b.losses) return a.losses < b.losses;
  if (a.ties !== b.ties) return a.ties > b.ties;
  if (a.pointDifferential !== b.pointDifferential) return a.pointDifferential > b.pointDifferential;
  if (a.pointsFor !== b.pointsFor) return a.pointsFor > b.pointsFor;
  return false;
}

export function computeTeamMetrics(schedule: TeamScheduleWithContext[]): TeamLeagueMetrics {
  const completedGames = schedule.filter((entry) => entry.isActual && entry.status === "final");
  const upcomingGames = schedule.filter((entry) => !entry.isActual || entry.status === "in_progress");

  let wins = 0;
  let losses = 0;
  let ties = 0;
  let pointsFor = 0;
  let pointsAgainst = 0;

  for (const entry of completedGames) {
    if (entry.result === "win") wins += 1;
    else if (entry.result === "loss") losses += 1;
    else if (entry.result === "tie") ties += 1;

    const fallbackFor = entry.projected_points ?? 0;
    const fallbackAgainst = entry.opponent_projected_points ?? 0;
    pointsFor += normaliseScore(entry.actualPoints, fallbackFor);
    pointsAgainst += normaliseScore(entry.opponentActualPoints, fallbackAgainst);
  }

  const gamesPlayed = completedGames.length;
  const pointDifferential = pointsFor - pointsAgainst;
  const pointsPerGame = gamesPlayed > 0 ? pointsFor / gamesPlayed : null;
  const currentStreak = computeStreak(completedGames);
  const nextGame = upcomingGames[0] ?? null;

  const upcomingWinsSamples = upcomingGames
    .map((entry) => entry.opponentStanding?.projected_record?.wins)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const upcomingPlayoffOddsSamples = upcomingGames
    .map((entry) => entry.opponentMonteCarlo?.playoff_odds)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    wins,
    losses,
    ties,
    gamesPlayed,
    pointsFor,
    pointsAgainst,
    pointDifferential,
    pointsPerGame,
    currentStreak,
    nextGame,
    upcomingAvgWins: mean(upcomingWinsSamples),
    upcomingAvgPlayoffOdds: mean(upcomingPlayoffOddsSamples),
  };
}
