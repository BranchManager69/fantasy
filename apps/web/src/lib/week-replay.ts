export type ReplayPlayer = {
  id: number;
  name: string;
  points: number;
  headshotUrl: string | null;
};

export type ReplayTeam = {
  id: number;
  name: string;
  score: number;
  final: boolean;
  player: ReplayPlayer | null;
};

export type ReplayMove = ReplayPlayer & { from: string; to: string };

export type ReplayPlay = {
  id: string;
  title: string;
  description: string;
  playerId: number;
  playerName: string;
  teamId: number;
  quarter: number;
  clock: string;
  points: number;
  before: Record<string, number>;
  after: Record<string, number>;
  sourceUrl: string;
  methodNote: string;
};

export type ReplayBestLineup = {
  available: boolean;
  retrospective: true;
  caveat: string;
  score?: number;
  gain?: number;
  margin?: number;
  moves: ReplayMove[];
  reason?: string;
};

export type ReplayMatchup = {
  team: ReplayTeam;
  opponent: ReplayTeam;
  allPlay: { wins: number; losses: number; ties: number } | null;
  play?: ReplayPlay;
  bestLineup: ReplayBestLineup;
};

export type WeekReplays = Record<string, ReplayMatchup>;
