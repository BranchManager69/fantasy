import { promises as fs } from "node:fs";
import path from "node:path";
import type { LeagueWeek, WeekMoments, WeekPlayer, WeekTeam } from "@/lib/league-week";
import type { ReplayBestLineup, ReplayMove, ReplayPlay, ReplayPlayer, ReplayTeam, WeekReplays } from "@/lib/week-replay";
import { getDataRoot } from "@/lib/paths";
import { bestLegalLineup } from "./analyst-context";

const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const RETROSPECTIVE_CAVEAT = "Uses final points and historical slot eligibility. Kickoff locks, transactions and pregame information are not reconstructed. The opponent keeps its actual lineup; official tiebreaks are not simulated.";
const clip = (value: unknown, limit = 180) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const cents = (value: number) => Math.round(value * 100);
const validId = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0;

function unavailable(reason: string): ReplayBestLineup {
  return { available: false, retrospective: true, caveat: RETROSPECTIVE_CAVEAT, moves: [], reason };
}

/** Only roster settings from this exact historical period are used. Owner fields never leave this reader. */
async function requiredSlots(season: number, week: number): Promise<number[] | null> {
  const filename = path.join(getDataRoot(), "raw", "espn", String(season), `view-mMatchupScore-week-${week}.json`);
  let handle;
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SNAPSHOT_BYTES) return null;
    handle = await fs.open(filename, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_SNAPSHOT_BYTES) return null;
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== opened.size) return null;
    const snapshot = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (snapshot.seasonId !== season || snapshot.scoringPeriodId !== week) return null;
    const counts = snapshot.settings?.rosterSettings?.lineupSlotCounts;
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) return null;
    const slots: number[] = [];
    for (const [key, count] of Object.entries(counts)) {
      const id = Number(key);
      if (!/^\d+$/.test(key) || !Number.isInteger(id) || !finite(count) || !Number.isInteger(count) || count < 0 || count > 16) return null;
      if (![20, 21, 25, 26, 27].includes(id)) slots.push(...Array(count).fill(id));
      if (slots.length > 16) return null;
    }
    return slots.length ? slots : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function publicPlayer(player: WeekPlayer): ReplayPlayer | null {
  if (!Number.isInteger(player.id) || !finite(player.points) || !clip(player.name)) return null;
  return { id: player.id, name: clip(player.name), points: player.points,
    headshotUrl: player.id > 0 ? `https://a.espncdn.com/i/headshots/nfl/players/full/${player.id}.png` : null };
}

function publicTeam(team: WeekTeam, final: boolean): ReplayTeam {
  const starters = Array.isArray(team.players) ? team.players.filter((player) => player.starter && validId(player.id)) : [];
  const representative = [...starters].filter((player) => finite(player.points))
    .sort((a, b) => b.points! - a.points! || a.id - b.id)[0];
  return { id: team.id, name: clip(team.name), score: team.score, final,
    player: representative ? publicPlayer(representative) : null };
}

function bestLineup(team: WeekTeam, opponent: WeekTeam, slots: number[] | null, final: boolean): ReplayBestLineup {
  if (!final) return unavailable("Final matchup scores are required for a retrospective lineup comparison.");
  if (!slots) return unavailable("Historical lineup settings are unavailable; the complete legal lineup cannot be verified.");
  if (!Array.isArray(team.players) || !Array.isArray(opponent.players) || team.players.length > 40) {
    return unavailable("The saved historical roster could not be verified.");
  }
  const candidates = team.players.filter((player) => player.starter || player.slotId === 20);
  if (candidates.some((player) => !Number.isInteger(player.id) || !Number.isInteger(player.slotId)
    || !Array.isArray(player.eligibleSlots) || !player.eligibleSlots.length
    || player.eligibleSlots.some((slot) => !Number.isInteger(slot) || slot < 0))) {
    return unavailable("Historical player eligibility is incomplete; the best legal lineup cannot be verified.");
  }
  try {
    const result = bestLegalLineup(team, opponent, slots);
    if (!result.available) return unavailable(result.reason);
    const assignments = new Map(result.lineup.map((slot) => [slot.player.id, slot]));
    const moves: ReplayMove[] = [];
    for (const player of candidates) {
      const assignment = assignments.get(player.id);
      const destination = assignment?.slot_id ?? 20;
      if ((!player.starter && !assignment) || player.slotId === destination) continue;
      const summary = publicPlayer(player);
      if (!summary) return unavailable("A changed player's final points could not be verified.");
      moves.push({ ...summary, from: player.starter ? clip(player.slot, 30) : "Bench",
        to: assignment ? clip(assignment.slot, 30) : "Bench" });
    }
    moves.sort((a, b) => a.id - b.id);
    return { available: true, retrospective: true, caveat: RETROSPECTIVE_CAVEAT,
      score: result.optimal_score, gain: result.improvement, margin: result.margin, moves };
  } catch {
    return unavailable("The saved lineup could not be verified.");
  }
}

function verifiedPlay(report: LeagueWeek, moments: WeekMoments | null, team: WeekTeam, opponent: WeekTeam): ReplayPlay | undefined {
  if (!moments || moments.season !== report.season || moments.week !== report.week
    || !Array.isArray(moments.moments) || !moments.lead || !team.lineupReconciled || !opponent.lineupReconciled) return undefined;
  const lead = moments.lead as NonNullable<WeekMoments["lead"]> & {
    source_refs?: { moment_id?: string }; play_id?: string; nfl_game_id?: string;
  };
  const owner = [team, opponent].find((candidate) => candidate.id === lead.team_id);
  const players = owner?.players?.filter((player) => player.starter && player.name === lead.player_name && validId(player.id));
  if (players?.length !== 1 || !finite(players[0].points) || !finite(lead.fantasy_points)) return undefined;
  const ids = [team.id, opponent.id].map(String).sort();
  for (const scores of [lead.before, lead.after]) {
    if (!scores || typeof scores !== "object" || Array.isArray(scores)
      || Object.keys(scores).sort().join(",") !== ids.join(",") || ids.some((id) => !finite(scores[id]))) return undefined;
  }
  if (ids.some((id) => cents(lead.after[id]) - cents(lead.before[id]) !== (id === String(lead.team_id) ? cents(lead.fantasy_points) : 0))) return undefined;
  const sourceUrl = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${report.season}.csv.gz`;
  if (lead.source_url !== sourceUrl || !Number.isInteger(lead.quarter) || lead.quarter < 1 || lead.quarter > 10
    || !clip(lead.clock, 30) || !clip(lead.title) || !clip(lead.method_note, 1000)) return undefined;
  const matching = moments.moments.filter((moment) => moment.team_id === lead.team_id
    && moment.player_name === lead.player_name && moment.quarter === lead.quarter && moment.clock === lead.clock
    && finite(moment.fantasy_points) && cents(moment.fantasy_points) === cents(lead.fantasy_points)
    && moment.source_url === sourceUrl && (!lead.source_refs?.moment_id || moment.id === lead.source_refs.moment_id)
    && (!lead.nfl_game_id || moment.nfl_game_id === lead.nfl_game_id));
  if (matching.length !== 1 || !clip(matching[0].id) || !clip(matching[0].description, 1500)) return undefined;
  return { id: clip(matching[0].id), title: clip(lead.title), description: clip(matching[0].description, 1500),
    playerId: players[0].id, playerName: clip(players[0].name), teamId: lead.team_id,
    quarter: lead.quarter, clock: clip(lead.clock, 30), points: lead.fantasy_points,
    before: Object.fromEntries(ids.map((id) => [id, lead.before[id]])),
    after: Object.fromEntries(ids.map((id) => [id, lead.after[id]])), sourceUrl, methodNote: clip(lead.method_note, 1000) };
}

/** Builds a public, serializable view. Missing evidence removes the comparison, never the official score. */
export async function buildWeekReplays(report: LeagueWeek, moments: WeekMoments | null): Promise<WeekReplays> {
  if (!report || !Number.isInteger(report.season) || report.season < 2000 || report.season > 2100
    || !Number.isInteger(report.week) || report.week < 1 || report.week > 18
    || !Array.isArray(report.teams) || report.teams.length > 32) return {};
  const slots = await requiredSlots(report.season, report.week);
  const teams = report.teams.filter((team) => validId(team.id) && finite(team.score));
  const byId = new Map(teams.map((team) => [team.id, team]));
  if (byId.size !== teams.length) return {};
  const replays: WeekReplays = {};
  for (const team of teams) {
    if (!validId(team.opponentId) || !finite(team.opponentScore)) continue;
    const opponent = byId.get(team.opponentId);
    const matchup = report.matchups?.find((entry) => entry.id === team.matchupId
      && [entry.homeId, entry.awayId].includes(team.id) && [entry.homeId, entry.awayId].includes(team.opponentId));
    const matching = opponent && opponent.id !== team.id && opponent.opponentId === team.id
      && opponent.matchupId === team.matchupId && cents(opponent.score) === cents(team.opponentScore)
      && cents(team.score) === cents(opponent.opponentScore) && matchup;
    const final = Boolean(matching && matchup?.final && team.final && opponent?.final
      && Number.isInteger(report.currentWeek) && report.week <= report.currentWeek);
    const play = final && opponent ? verifiedPlay(report, moments, team, opponent) : undefined;
    const allPlay = team.allPlay;
    const validAllPlay = report.complete && final && allPlay
      && [allPlay.wins, allPlay.losses, allPlay.ties].every((value) => Number.isInteger(value) && value >= 0)
      && allPlay.wins + allPlay.losses + allPlay.ties === teams.length - 1;
    replays[String(team.id)] = {
      team: publicTeam(team, final),
      opponent: opponent ? publicTeam(opponent, final)
        : { id: team.opponentId, name: clip(team.opponentName), score: team.opponentScore, final: false, player: null },
      allPlay: validAllPlay ? { wins: allPlay.wins, losses: allPlay.losses, ties: allPlay.ties } : null,
      ...(play ? { play } : {}),
      bestLineup: matching && opponent ? bestLineup(team, opponent, slots, final)
        : unavailable("The opponent's historical matchup could not be verified."),
    };
  }
  return replays;
}
