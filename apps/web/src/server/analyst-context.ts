import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import type { AgentToolParam } from "openai/resources/beta/agents/agents";
import { loadLeagueWeek, type WeekPlayer, type WeekTeam } from "@/lib/league-week";
import { getDataRoot } from "@/lib/paths";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
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
  let playResult: Promise<unknown> | undefined;

  return {
    tools, sources,
    async call(name, args) {
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
}
