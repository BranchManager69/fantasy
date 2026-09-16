import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import type { AgentToolParam } from "openai/resources/beta/agents/agents";
import { loadLeagueWeek, type WeekPlayer, type WeekTeam } from "@/lib/league-week";
import { getDataRoot } from "@/lib/paths";
import { compactLeagueTimeline, loadLeagueTimeline } from "./analyst-timeline";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_INITIAL_BYTES = 16 * 1024;
const MAX_PLAYS = 8;
type Source = { label: string; url: string };
type CsvRow = Record<string, string>;

const tools: AgentToolParam[] = [
  {
    type: "function", name: "get_matchup",
    description: "Get this selected team's historical ESPN matchup, official lineups, points, final state, and all-play record. The team and week are already fixed. This is cached evidence, not a live feed.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function", name: "get_bench_alternatives",
    description: "Get up to eight eligible single bench-to-starter swaps, ranked by the retrospective score difference. These use final points and recorded slot eligibility; they do not establish what a manager should have known or whether a kickoff-time swap was possible. A points tie does not establish the official tiebreak result.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function", name: "get_best_lineup",
    description: "Get the exact highest-scoring complete lineup from this team's historical starters and true bench, with legal slot assignments, concrete player changes, and comparison against the opponent's actual score. Includes coordinated position moves that a single swap misses. Retrospective final-points evidence, not a pregame recommendation or proof a late swap was possible.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function", name: "get_league_timeline",
    description: "Get this week's observed NFL game sequence, league-wide starter coverage, players remaining at the latest game's first observed play, and the selected matchup's chronological notable plays. Also explains automatic feature ranking. Remaining players do not establish an undecided matchup. Whole-league fantasy scores and win probabilities are not reconstructed play by play.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function", name: "get_game_moments",
    description: "Get sourced NFL plays involving starters in this matchup. Some featured moments have separately verified league-point effects; other plays have no proven fantasy-point delta or lead-change claim. An interception's targeted receiver is not the player charged with that turnover.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function round(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100; }
function clip(value: unknown, max = 180): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function numeric(value: string | undefined) { const n = Number(value || 0); return Number.isFinite(n) ? n : 0; }

async function checkSize(filename: string, optional = false): Promise<boolean> {
  try {
    const stat = await fs.stat(filename);
    ensure(stat.isFile() && stat.size <= MAX_FILE_BYTES, "An evidence file exceeds the supported size limit");
    return true;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof Error && error.message.includes("supported size limit")) throw error;
    throw new Error("Required cached league evidence is unavailable");
  }
}

async function readBoundedCsv(filename: string, columns: string[]): Promise<CsvRow[]> {
  await checkSize(filename);
  let handle;
  try {
    handle = await fs.open(filename, "r");
    const stat = await handle.stat();
    ensure(stat.isFile() && stat.size <= MAX_FILE_BYTES, "An evidence file exceeds the supported size limit");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    ensure(offset <= stat.size, "Evidence changed while reading; retry with a stable snapshot");
    const wanted = new Set(columns);
    return parse(buffer.subarray(0, offset), {
      columns: (header: string[]) => header.map((name) => wanted.has(name) ? name : false),
      skip_empty_lines: true, bom: true, max_record_size: 128 * 1024,
    }) as CsvRow[];
  } catch (error) {
    if (error instanceof Error && /size limit|stable snapshot/.test(error.message)) throw error;
    throw new Error("Cached NFL play evidence could not be read");
  } finally {
    await handle?.close();
  }
}

function publicPlayer(player: WeekPlayer) {
  return {
    id: player.id, name: clip(player.name), position: clip(player.position, 12),
    slot: clip(player.slot, 30), slot_id: player.slotId, starter: player.starter,
    points: Number.isFinite(player.points) ? player.points : null,
    eligible_slots: player.eligibleSlots.filter(Number.isInteger).slice(0, 30),
  };
}

function publicTeam(team: WeekTeam, complete: boolean) {
  return {
    id: team.id, name: clip(team.name), official_score: team.score,
    official_result: clip(team.result, 20), final: team.final,
    lineup_reconciled: team.lineupReconciled, starter_total: team.starterTotal,
    all_play: complete ? team.allPlay : null,
    starters: team.players.filter((p) => p.starter).map(publicPlayer),
    bench: team.players.filter((p) => !p.starter && p.slotId === 20).map(publicPlayer),
    reserve: team.players.filter((p) => !p.starter && p.slotId !== 20).map(publicPlayer),
  };
}

function benchAlternatives(team: WeekTeam, opponent: WeekTeam) {
  const caveat = "Retrospective final-points arithmetic and recorded ESPN slot eligibility only. This does not reconstruct kickoff locks, injuries known beforehand, or a recommended decision. Official results remain unchanged; league tiebreak rules are not simulated.";
  if (!team.final || !opponent.final || !team.lineupReconciled || !opponent.lineupReconciled) {
    return { available: false, alternatives: [], caveat, reason: "Final, reconciled lineups are required" };
  }
  const starters = team.players.filter((p) => p.starter && p.points !== null && Number.isFinite(p.points));
  const bench = team.players.filter((p) => !p.starter && p.slotId === 20 && p.points !== null && Number.isFinite(p.points));
  const alternatives = starters.flatMap((outgoing) => bench
    .filter((incoming) => incoming.id !== outgoing.id && incoming.eligibleSlots.includes(outgoing.slotId))
    .map((incoming) => {
      const difference = round(incoming.points! - outgoing.points!);
      const revised = round(team.score + difference);
      const margin = round(revised - opponent.score);
      return {
        outgoing: { id: outgoing.id, name: clip(outgoing.name), points: outgoing.points, slot: clip(outgoing.slot, 30) },
        incoming: { id: incoming.id, name: clip(incoming.name), points: incoming.points, slot_id: 20 },
        score_difference: difference, revised_score: revised, opponent_score: opponent.score,
        revised_margin: margin, points_comparison: margin === 0 ? "tied_on_points" : margin > 0 ? "ahead_on_points" : "behind_on_points",
      };
    }))
    .sort((a, b) => b.score_difference - a.score_difference || a.outgoing.id - b.outgoing.id || a.incoming.id - b.incoming.id);
  return { available: true, official_score: team.score, eligible_swap_count: alternatives.length,
    improving_swap_count: alternatives.filter((a) => a.score_difference > 0).length,
    alternatives: alternatives.slice(0, 8), caveat };
}

const LINEUP_CAVEAT = "Exact retrospective assignment using final ESPN points, recorded position eligibility, and the historical starter slots. Only historical starters and true bench players (slot 20) are candidates; reserve/IR are excluded. The opponent keeps its actual lineup. This does not reconstruct kickoff locks, available information before games, transactions, or official tie-breaking.";

/** Maximum-weight bipartite assignment, with each player used at most once.
 * Slot-mask DP is exact, including FLEX moves; a greedy positional sort is not.
 */
export function bestLegalLineup(team: WeekTeam, opponent: WeekTeam, requiredSlotIds?: number[]) {
  const unavailable = (reason: string) => ({ available: false as const, reason, caveat: LINEUP_CAVEAT });
  if (!team.final || !opponent.final || !team.lineupReconciled || !opponent.lineupReconciled) {
    return unavailable("Final, reconciled historical lineups are required");
  }
  const slots = team.players.filter((p) => p.starter).sort((a, b) => a.slotId - b.slotId || a.id - b.id);
  if (!slots.length || slots.length > 16) return unavailable("Supported complete lineups require 1–16 starter slots");
  if (requiredSlotIds && (requiredSlotIds.length !== slots.length
    || [...requiredSlotIds].sort((a, b) => a - b).some((id, index) => id !== slots[index].slotId))) {
    return unavailable("The recorded starters do not fill the configured lineup slots");
  }
  const candidates = team.players.filter((p) => p.starter || p.slotId === 20).sort((a, b) => a.id - b.id);
  if (new Set(candidates.map((p) => p.id)).size !== candidates.length) return unavailable("Duplicate historical player IDs");
  if (slots.some((p) => !p.eligibleSlots.includes(p.slotId))) return unavailable("A recorded starter's eligibility does not include its slot");
  const eligible = candidates.filter((p) => slots.some((slot) => p.eligibleSlots.includes(slot.slotId)));
  if (eligible.some((p) => p.points === null || !Number.isFinite(p.points))) {
    return unavailable("An eligible historical player has no verified final score; the maximum cannot be proved");
  }
  const cents = (value: number) => Math.round(value * 100);
  if (cents(slots.reduce((sum, p) => sum + p.points!, 0)) !== cents(team.score)) {
    return unavailable("The historical starter scores do not reconcile to the official total");
  }
  type Assignment = { points: number; changes: number; playerIds: number[] };
  const states: (Assignment | undefined)[] = Array(1 << slots.length);
  states[0] = { points: 0, changes: 0, playerIds: Array(slots.length).fill(0) };
  function preferred(next: Assignment, previous: Assignment | undefined) {
    if (!previous) return true;
    if (next.points !== previous.points) return next.points > previous.points;
    if (next.changes !== previous.changes) return next.changes < previous.changes;
    for (let i = 0; i < slots.length; i++) {
      if (next.playerIds[i] !== previous.playerIds[i]) return next.playerIds[i] < previous.playerIds[i];
    }
    return false;
  }
  for (const player of eligible) {
    // Descending masks prevent reusing this player in a state created on this iteration.
    for (let mask = states.length - 1; mask >= 0; mask--) {
      const previous = states[mask];
      if (!previous) continue;
      for (let slot = 0; slot < slots.length; slot++) {
        if ((mask & (1 << slot)) || !player.eligibleSlots.includes(slots[slot].slotId)) continue;
        const next = { points: previous.points + cents(player.points!),
          changes: previous.changes + Number(player.id !== slots[slot].id), playerIds: [...previous.playerIds] };
        next.playerIds[slot] = player.id;
        const nextMask = mask | (1 << slot);
        if (preferred(next, states[nextMask])) states[nextMask] = next;
      }
    }
  }
  const optimum = states[states.length - 1];
  if (!optimum) return unavailable("No complete eligible lineup can be assigned");
  const byId = new Map(eligible.map((p) => [p.id, p]));
  const selected = new Set(optimum.playerIds);
  const playerSummary = (p: WeekPlayer) => ({ id: p.id, name: clip(p.name), points: p.points });
  const counts = new Map<number, number>();
  const lineup = slots.map((slot, index) => {
    const instance = (counts.get(slot.slotId) ?? 0) + 1;
    counts.set(slot.slotId, instance);
    const player = byId.get(optimum.playerIds[index])!;
    return { slot_instance: `${slot.slotId}:${instance}`, slot_id: slot.slotId, slot: clip(slot.slot, 30),
      player: playerSummary(player), original_player: playerSummary(slot), changed: player.id !== slot.id };
  });
  ensure(new Set(lineup.map((s) => s.player.id)).size === slots.length
    && lineup.every((s) => byId.get(s.player.id)!.eligibleSlots.includes(s.slot_id))
    && lineup.reduce((sum, s) => sum + cents(s.player.points!), 0) === optimum.points,
  "Optimal lineup failed independent eligibility and score verification");
  const margin = optimum.points - cents(opponent.score);
  return { available: true as const, algorithm: "exact_slot_assignment" as const,
    official_score: team.score, opponent_score: opponent.score,
    optimal_score: optimum.points / 100, improvement: (optimum.points - cents(team.score)) / 100,
    margin: margin / 100, points_comparison: margin === 0 ? "tied_on_points" : margin > 0 ? "ahead_on_points" : "behind_on_points",
    can_outscore_opponent: margin > 0, lineup, changes: lineup.filter((s) => s.changed),
    promoted_bench: eligible.filter((p) => !p.starter && selected.has(p.id)).map(playerSummary),
    benched_starters: slots.filter((p) => !selected.has(p.id)).map(playerSummary),
    starter_slot_moves: lineup.filter((s) => byId.get(s.player.id)!.starter && byId.get(s.player.id)!.slotId !== s.slot_id)
      .map((s) => ({ player: s.player, from_slot_id: byId.get(s.player.id)!.slotId, to_slot_id: s.slot_id, to_slot: s.slot })),
    candidate_count: eligible.length, slots_verified_against_settings: Boolean(requiredSlotIds), caveat: LINEUP_CAVEAT };
}

async function historicalSlotIds(root: string, season: number, week: number): Promise<number[] | undefined> {
  const filename = path.join(root, "raw", "espn", String(season), `view-mMatchupScore-week-${week}.json`);
  if (!await checkSize(filename, true)) return undefined;
  const snapshot = JSON.parse(await fs.readFile(filename, "utf8"));
  ensure(snapshot.seasonId === season && snapshot.scoringPeriodId === week, "Historical slot settings do not match the selected week");
  const counts = snapshot.settings?.rosterSettings?.lineupSlotCounts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return undefined;
  const slots: number[] = [];
  for (const [key, value] of Object.entries(counts)) {
    const id = Number(key);
    if ([20, 21, 25, 26, 27].includes(id)) continue;
    ensure(Number.isInteger(id) && id >= 0 && typeof value === "number"
      && Number.isInteger(value) && value >= 0 && value <= 16, "Invalid historical lineup slot count");
    slots.push(...Array(value).fill(id));
  }
  ensure(slots.length <= 16, "Too many historical starter slots");
  return slots;
}

const PBP_COLUMNS = ["season", "week", "season_type", "game_id", "play_id", "game_date", "time_of_day",
  "qtr", "time", "desc", "play_type", "play_deleted", "touchdown", "interception", "fumble_lost",
  "yards_gained", "passer_player_id", "rusher_player_id", "receiver_player_id", "fumbled_1_player_id", "fumbled_2_player_id"];

async function nflPlayMoments(root: string, season: number, week: number, teams: WeekTeam[], source: Source) {
  const [mapping, rows] = await Promise.all([
    readBoundedCsv(path.join(root, "raw", "nflverse", "players.csv"), ["espn_id", "gsis_id"]),
    readBoundedCsv(path.join(root, "raw", "nflverse", `play_by_play_${season}.csv`), PBP_COLUMNS),
  ]);
  const starters = new Map(teams.flatMap((t) => t.players.filter((p) => p.starter)
    .map((p) => [String(p.id), { id: p.id, name: clip(p.name), team_id: t.id }] as const)));
  const mapped = new Map<string, { id: number; name: string; team_id: number }>();
  const duplicateEspn = new Set<string>();
  const seenEspn = new Set<string>();
  for (const row of mapping) {
    const id = row.espn_id.replace(/\.0$/, "");
    const starter = starters.get(id);
    if (!starter || !row.gsis_id) continue;
    if (seenEspn.has(id)) duplicateEspn.add(id);
    seenEspn.add(id);
    mapped.set(row.gsis_id, starter);
  }
  for (const [gsis, starter] of mapped) if (duplicateEspn.has(String(starter.id))) mapped.delete(gsis);
  const candidates = new Map<string, { priority: number; moment: Record<string, unknown> }>();
  for (const row of rows) {
    if (numeric(row.season) !== season || numeric(row.week) !== week || row.season_type !== "REG"
      || numeric(row.play_deleted) !== 0 || row.play_type === "no_play"
      || !/^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(row.game_id)) continue;
    const roles = ["passer_player_id", "rusher_player_id", "receiver_player_id", "fumbled_1_player_id", "fumbled_2_player_id"];
    const involved = roles.flatMap((role) => {
      const player = mapped.get(row[role]);
      return player ? [{ ...player, role: role.replace("_player_id", "") }] : [];
    });
    if (!involved.length) continue;
    const touchdown = numeric(row.touchdown) === 1;
    const interception = numeric(row.interception) === 1;
    const fumble = numeric(row.fumble_lost) === 1;
    const yards = numeric(row.yards_gained);
    if (!touchdown && !interception && !fumble && yards < 30) continue;
    const key = `${row.game_id}:${row.play_id}`;
    candidates.set(key, {
      priority: (touchdown ? 100 : interception || fumble ? 90 : 30) + Math.min(Math.abs(yards), 99) / 100,
      moment: { id: key, nfl_game_id: row.game_id, play_id: clip(row.play_id, 20),
        date: clip(row.game_date, 10), time_of_day: clip(row.time_of_day, 40),
        quarter: numeric(row.qtr), clock: clip(row.time, 12), description: clip(row.desc, 1200),
        involved_starters: involved, touchdown, interception, fumble_lost: fumble, yards_gained: yards,
        source_url: source.url, evidence_kind: "nfl_play_only" },
    });
  }
  return {
    available: candidates.size > 0, evidence_kind: "nfl_play_only",
    moments: [...candidates.values()].sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_PLAYS).map((entry) => entry.moment),
    matching_play_count: candidates.size, starter_count: starters.size,
    mapped_starter_count: new Set([...mapped.values()].map((p) => p.id)).size,
    note: "A bounded sample of touchdown, turnover, and 30+ yard plays involving historical starters, prioritized by event type. These NFL events have not been translated into league fantasy-point changes or a live fantasy scoreboard. A targeted receiver is not charged with the quarterback's interception.",
  };
}

export async function createAnalystContext(season: number, week: number, teamId: number): Promise<{
  tools: AgentToolParam[];
  call(name: string, args: unknown): Promise<unknown>;
  sources: Source[];
  initialEvidence: string;
  initialEvidenceBytes: number;
}> {
  ensure(Number.isInteger(season) && season >= 2000 && season <= 2100
    && Number.isInteger(week) && week >= 1 && week <= 18
    && Number.isInteger(teamId) && teamId > 0, "Invalid league context selection");
  const root = getDataRoot();
  const reportPath = path.join(root, "out", "league", String(season), `week_${week}.json`);
  const momentsPath = path.join(root, "out", "league", String(season), `week_${week}_moments.json`);
  await Promise.all([checkSize(reportPath), checkSize(momentsPath, true)]);
  let loaded: Awaited<ReturnType<typeof loadLeagueWeek>>;
  try { loaded = await loadLeagueWeek(season, week); }
  catch { throw new Error("The selected historical week could not be loaded"); }
  const { report, moments } = loaded;
  ensure(report && report.teams.length <= 32, "The selected historical week is unavailable");
  const team = report.teams.find((t) => t.id === teamId);
  const opponent = team && report.teams.find((t) => t.id === team.opponentId);
  ensure(team && opponent && team.matchupId === opponent.matchupId && opponent.opponentId === team.id,
    "The selected team has no matching opponent in this week");
  ensure([team, opponent].every((t) => Array.isArray(t.players) && t.players.length <= 40
    && Number.isFinite(t.score) && t.players.every((p) => Array.isArray(p.eligibleSlots))), "The historical matchup is malformed");
  let leagueId: string | null = null;
  try {
    const url = new URL(report.sourceUrl);
    if (url.protocol === "https:" && url.hostname === "fantasy.espn.com") leagueId = url.searchParams.get("leagueId");
  } catch { /* Reject invalid artifact URLs instead of exposing them as sources. */ }
  ensure(leagueId && /^\d+$/.test(leagueId), "The historical ESPN source is invalid");
  const sources: Source[] = [
    { label: "ESPN historical matchup", url: `https://fantasy.espn.com/football/league/scoreboard?leagueId=${leagueId}&seasonId=${season}&matchupPeriodId=${week}` },
    { label: "nflverse play-by-play", url: `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz` },
  ];
  const generatedMs = Date.parse(report.generatedAt);
  const context = { season, week, team_id: teamId, matchup_id: team.matchupId,
    snapshot_generated_at: Number.isFinite(generatedMs) ? new Date(generatedMs).toISOString() : null,
    snapshot_age_hours: Number.isFinite(generatedMs) ? round(Math.max(0, Date.now() - generatedMs) / 3_600_000) : null,
    caveat: "Cached historical evidence, not live scores. NFL and fantasy stats may receive corrections. Retrospective arithmetic does not establish what managers knew before kickoff.", sources };
  const starterNames = new Map([team, opponent].map((t) => [t.id, new Set(t.players.filter((p) => p.starter).map((p) => p.name))]));
  const verified = moments?.moments.filter((m) => starterNames.get(m.team_id)?.has(m.player_name)) ?? [];
  const requiredSlots = await historicalSlotIds(root, season, week);
  const bestLineup = requiredSlots ? bestLegalLineup(team, opponent, requiredSlots)
    : { available: false as const, reason: "Historical starter slot settings are unavailable; a complete legal lineup cannot be proved", caveat: LINEUP_CAVEAT };
  const timelineEvidence = loadLeagueTimeline(root, report).then((value) => ({ available: true as const,
    ...compactLeagueTimeline(value, teamId) })).catch(() => ({ available: false as const,
    note: "Cached whole-week sequence is unavailable or could not be verified. Do not infer game completion or remaining starters." }));
  let playResult: Promise<unknown> | undefined;

  const api = {
    tools, sources,
    async call(name: string, args: unknown): Promise<unknown> {
      ensure(args === undefined || args === null || (typeof args === "object" && !Array.isArray(args)
        && Object.keys(args).length === 0), "This tool accepts no arguments; team and week are fixed");
      let payload: unknown;
      switch (name) {
        case "get_matchup":
          payload = { ...context, league_name: clip(report.leagueName), week_complete: report.complete,
            selected: publicTeam(team, report.complete), opponent: publicTeam(opponent, report.complete) };
          break;
        case "get_bench_alternatives":
          payload = { ...context, ...benchAlternatives(team, opponent) };
          break;
        case "get_best_lineup":
          payload = { ...context, ...bestLineup };
          break;
        case "get_league_timeline":
          payload = { ...context, ...await timelineEvidence };
          break;
        case "get_game_moments":
          if (verified.length) {
            payload = { ...context, available: true, evidence_kind: "verified_fantasy_scoring",
              lead: moments?.lead && starterNames.get(moments.lead.team_id)?.has(moments.lead.player_name)
                ? { title: clip(moments.lead.title, 180), summary: clip(moments.lead.summary, 1500),
                    before: Object.fromEntries([team.id, opponent.id]
                      .map((id) => [String(id), moments.lead!.before?.[String(id)]] as const)
                      .filter((entry): entry is readonly [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))),
                    after: Object.fromEntries([team.id, opponent.id]
                      .map((id) => [String(id), moments.lead!.after?.[String(id)]] as const)
                      .filter((entry): entry is readonly [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))),
                    note: clip(moments.lead.method_note, 700), source_url: sources[1].url } : null,
              moments: verified.slice(0, MAX_PLAYS).map((m) => ({ id: clip(m.id), player_name: clip(m.player_name),
                team_id: m.team_id, nfl_game_id: clip(m.nfl_game_id, 40), quarter: m.quarter, clock: clip(m.clock, 25),
                description: clip(m.description, 1500), ...(Number.isFinite(m.fantasy_points) ? { fantasy_points: m.fantasy_points } : {}),
                note: clip(m.note, 1000), source_url: sources[1].url })) };
          } else {
            playResult ??= nflPlayMoments(root, season, week, [team, opponent], sources[1])
              .catch(() => ({ available: false, moments: [], note: "Cached NFL play context is unavailable or exceeds the supported size limit. Do not infer missing game events." }));
            payload = { ...context, ...await playResult as object };
          }
          break;
        default: throw new Error("Unknown league evidence tool");
      }
      ensure(Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_RESULT_BYTES, "League tool response exceeds the supported size limit");
      return payload;
    },
  };
  const [momentEvidence, timeline] = await Promise.all([
    api.call("get_game_moments", {}) as Promise<Record<string, unknown>>, timelineEvidence,
  ]);
  const compactTeam = (value: WeekTeam) => ({ id: value.id, name: clip(value.name), score: value.score,
    result: value.result, final: value.final, lineup_reconciled: value.lineupReconciled,
    all_play: report.complete ? value.allPlay : null,
    starters: value.players.filter((p) => p.starter).map((p) => ({ id: p.id, name: clip(p.name), slot: p.slot, points: p.points })) });
  const seed = {
    schema: "fantasy_analyst_initial_evidence", version: 1,
    evidenceKind: "cached_historical_league_evidence",
    selection: { season, week, teamId, matchupId: team.matchupId },
    snapshot_generated_at: context.snapshot_generated_at, snapshot_age_hours: context.snapshot_age_hours,
    caveat: context.caveat, sources,
    matchup: { week_complete: report.complete, selected: compactTeam(team), opponent: compactTeam(opponent) },
    best_lineup: bestLineup.available ? { ...bestLineup,
      lineup: bestLineup.lineup.map((s) => ({ slot: s.slot, slot_id: s.slot_id, player: s.player })) } : bestLineup,
    league_timeline: timeline.available ? { available: true, coverage: timeline.coverage,
      latest_game_id: timeline.latest_game_id, latest_game_first_observed_at: timeline.latest_game_first_observed_at,
      matchups_with_players_in_latest_window: timeline.matchups_with_players_in_latest_window,
      league_matchups_at_latest_game: timeline.league_matchups_at_latest_game,
      selected_matchup: timeline.selected_matchup, selected_feature: timeline.selected_feature,
      ranking_method: timeline.ranking_method, caveat: timeline.caveat } : timeline,
    game_moments: { available: momentEvidence.available, evidence_kind: momentEvidence.evidence_kind,
      lead: momentEvidence.lead, note: momentEvidence.note,
      moments: Array.isArray(momentEvidence.moments) ? momentEvidence.moments.slice(0, 4).map((m) => ({
        ...m, description: clip(m.description, 650), note: clip(m.note, 300),
      })) : [],
      full_moment_count: Array.isArray(momentEvidence.moments) ? momentEvidence.moments.length : 0 },
  };
  let initialEvidence = JSON.stringify(seed);
  if (Buffer.byteLength(initialEvidence, "utf8") > MAX_INITIAL_BYTES) {
    seed.game_moments.moments = seed.game_moments.moments.slice(0, 1);
    seed.matchup.selected.starters = [];
    seed.matchup.opponent.starters = [];
    initialEvidence = JSON.stringify({ ...seed, omitted_detail: "Full lineups and additional moments are available through the tools" });
  }
  ensure(Buffer.byteLength(initialEvidence, "utf8") <= MAX_INITIAL_BYTES, "Initial league evidence exceeds the supported size limit");
  return { ...api, initialEvidence, initialEvidenceBytes: Buffer.byteLength(initialEvidence, "utf8") };
}
