import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import type { LeagueWeek } from "@/lib/league-week";

type Row = Record<string, string>;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const number = (value: string | undefined) => Number(value || 0);
const validTime = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const clip = (value: string | undefined, limit = 1200) => (value ?? "").slice(0, limit);
const roles = ["passer_player_id", "rusher_player_id", "receiver_player_id", "fumbled_1_player_id", "fumbled_2_player_id"];
export const TIMELINE_CAVEAT = "Retrospective cached NFL play sequence and historical fantasy starters. Observed UTC play times are not scheduled kickoff or final-whistle times. END GAME markers establish a completed cached NFL game, not when ESPN declared a fantasy winner. Remaining players do not mean a matchup was undecided or mathematically winnable. Whole-league fantasy scores and win probabilities are not reconstructed play by play.";

export type TimelinePlayer = { id: number; name: string; team_id: number; points: number | null; nfl_games: string[] };
export type TimelineGame = { id: string; date: string; first_observed_at: string | null; last_observed_at: string | null;
  end_game_observed_at: string | null; has_end_game_marker: boolean; play_count: number; timed_play_count: number };
export type TimelineMatchup = { id: number; teams: { id: number; name: string; official_score: number;
  completed_points_before_latest_game: number | null; remaining_starters: TimelinePlayer[];
  unknown_starters: TimelinePlayer[]; starter_count: number }[]; remaining_starter_count: number; timing_coverage_complete: boolean };
export type TimelineCandidate = { id: string; nfl_game_id: string; play_id: string; date: string; observed_at: string | null;
  quarter: number; clock: string; description: string; source_url: string; involved_starters: (TimelinePlayer & { role: string })[];
  event_type: "touchdown" | "turnover" | "long_gain"; yards: number; latest_game: boolean;
  editorial_score: number; ranking_reasons: string[] };
export type TimelineFeature = { candidate_id: string; title: string; summary: string; player_name: string; team_id: number;
  quarter: number; clock: string; source_url: string; selection_basis: string[]; evidence_kind: string;
  fantasy_points?: number; before?: Record<string, number>; after?: Record<string, number> };
export type LeagueTimeline = { schema: "fantasy_week_timeline"; version: 1; season: number; week: number; generated_at: string;
  source_report_generated_at: string; evidence_kind: "observed_nfl_sequence"; source_url: string; caveat: string;
  coverage: { nfl_games: number; raw_plays: number; timed_plays: number; historical_starters: number;
    mapped_starters: number; starters_with_observed_games: number; candidate_count: number; fantasy_score_reconstruction: "featured_verified_play_only" };
  games: TimelineGame[]; latest_game_id: string | null; latest_game_first_observed_at: string | null;
  matchups: TimelineMatchup[]; matchups_with_players_in_latest_window: number; moments: TimelineCandidate[];
  ranking_method: string; rankedCandidates: TimelineCandidate[]; selectedFeature: TimelineFeature | null };

export function buildLeagueTimeline(report: LeagueWeek, mapping: Row[], inputRows: Row[], verified?: unknown): LeagueTimeline {
  const sourceUrl = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${report.season}.csv.gz`;
  const rows = inputRows.filter((r) => number(r.season) === report.season && number(r.week) === report.week
    && r.season_type === "REG" && number(r.play_deleted) === 0 && /^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(r.game_id));
  const gamesById = new Map<string, TimelineGame>();
  const starters = new Map<number, TimelinePlayer>();
  for (const t of report.teams) for (const p of t.players.filter((p) => p.starter)) {
    if (starters.has(p.id)) throw new Error("A starter appears on multiple fantasy teams");
    starters.set(p.id, { id: p.id, name: clip(p.name, 180), team_id: t.id, points: p.points, nfl_games: [] });
  }
  const associations = new Map<number, Set<string>>();
  const gsisOwners = new Map<string, Set<number>>();
  for (const row of mapping) {
    const id = Number(row.espn_id), gsis = row.gsis_id;
    if (!starters.has(id) || !gsis) continue;
    const ids = associations.get(id) ?? new Set<string>(); ids.add(gsis); associations.set(id, ids);
    const owners = gsisOwners.get(gsis) ?? new Set<number>(); owners.add(id); gsisOwners.set(gsis, owners);
  }
  const byGsis = new Map<string, TimelinePlayer>();
  for (const [id, ids] of associations) if (ids.size === 1) {
    const gsis = [...ids][0];
    if (gsisOwners.get(gsis)?.size === 1) byGsis.set(gsis, starters.get(id)!);
  }
  for (const row of rows) {
    const at = validTime(row.time_of_day);
    const game = gamesById.get(row.game_id) ?? { id: row.game_id, date: row.game_date,
      first_observed_at: null, last_observed_at: null, end_game_observed_at: null,
      has_end_game_marker: false, play_count: 0, timed_play_count: 0 };
    if (game.date !== row.game_date) throw new Error("NFL game dates disagree within the cached sequence");
    game.play_count++;
    if (at) {
      game.timed_play_count++;
      if (!game.first_observed_at || at < game.first_observed_at) game.first_observed_at = at;
      if (!game.last_observed_at || at > game.last_observed_at) game.last_observed_at = at;
    }
    if (row.desc?.trim() === "END GAME") { game.has_end_game_marker = true; game.end_game_observed_at = at; }
    gamesById.set(game.id, game);
    for (const role of roles) {
      const player = byGsis.get(row[role]);
      if (player && !player.nfl_games.includes(row.game_id)) player.nfl_games.push(row.game_id);
    }
  }
  const games = [...gamesById.values()].sort((a, b) => (a.first_observed_at ?? `${a.date}Z`).localeCompare(b.first_observed_at ?? `${b.date}Z`) || a.id.localeCompare(b.id));
  const latest = [...games].reverse().find((g) => g.first_observed_at) ?? null;
  function stateAtLatest(player: TimelinePlayer): "remaining" | "finished" | "unknown" {
    if (!latest || player.nfl_games.length !== 1) return "unknown";
    const game = gamesById.get(player.nfl_games[0])!;
    if (game.first_observed_at && game.first_observed_at >= latest.first_observed_at!) return "remaining";
    if (game.last_observed_at && game.last_observed_at >= latest.first_observed_at!) return "remaining";
    if (game.has_end_game_marker && (game.date < latest.date
      || (game.end_game_observed_at && game.end_game_observed_at < latest.first_observed_at!))) return "finished";
    return "unknown";
  }
  const matchups = report.matchups.map((m): TimelineMatchup => {
    const teams = [m.homeId, m.awayId].map((id) => {
      const team = report.teams.find((t) => t.id === id);
      if (!team) throw new Error("Timeline matchup is missing a fantasy team");
      const roster = [...starters.values()].filter((p) => p.team_id === id);
      const remaining = roster.filter((p) => stateAtLatest(p) === "remaining");
      const unknown = roster.filter((p) => stateAtLatest(p) === "unknown");
      const completed = !unknown.length && team.final && team.lineupReconciled && roster.every((p) => p.points !== null && Number.isFinite(p.points))
        ? Math.round((team.score - remaining.reduce((sum, p) => sum + p.points!, 0)) * 100) / 100 : null;
      return { id, name: clip(team.name, 180), official_score: team.score,
        completed_points_before_latest_game: completed, remaining_starters: remaining, unknown_starters: unknown, starter_count: roster.length };
    });
    return { id: m.id, teams, remaining_starter_count: teams.reduce((n, t) => n + t.remaining_starters.length, 0),
      timing_coverage_complete: teams.every((t) => !t.unknown_starters.length) };
  });
  const seenPlays = new Set<string>();
  const candidates: TimelineCandidate[] = [];
  for (const row of rows) {
    if (row.play_type === "no_play") continue;
    const touchdown = number(row.touchdown) === 1;
    const turnover = number(row.interception) === 1 || number(row.fumble_lost) === 1;
    const yards = number(row.yards_gained);
    if (!touchdown && !turnover && yards < 30) continue;
    const involved = roles.flatMap((role) => {
      const player = byGsis.get(row[role]);
      return player ? [{ ...player, role: role.replace("_player_id", "") }] : [];
    });
    if (!involved.length) continue;
    const id = `${row.game_id}:${row.play_id}`;
    if (seenPlays.has(id)) throw new Error("Duplicate notable play IDs in the cached sequence");
    seenPlays.add(id);
    const isLatest = row.game_id === latest?.id;
    // NFL's touchdown flag also covers defensive returns. A pick-six or lost
    // fumble returned for a score is a turnover for the offensive participants.
    const event = turnover ? "turnover" : touchdown ? "touchdown" : "long_gain";
    const eventScore = turnover ? 90 : touchdown ? 100 : 30;
    candidates.push({ id, nfl_game_id: row.game_id, play_id: clip(row.play_id, 30), date: clip(row.game_date, 10),
      observed_at: validTime(row.time_of_day), quarter: number(row.qtr), clock: clip(row.time, 12),
      description: clip(row.desc), source_url: sourceUrl, involved_starters: involved,
      event_type: event, yards, latest_game: isLatest,
      editorial_score: eventScore + Math.min(Math.abs(yards), 99) / 100,
      ranking_reasons: ["Heuristic candidate ordering; the story-selection step may choose a different play",
        `Observed NFL event: ${event}`, `${yards} yards on the recorded play`,
        "Involves a historical fantasy starter; no day-of-week or recency bonus", "This ordering does not prove a fantasy matchup swing"] });
  }
  const ranked = [...candidates].sort((a, b) => b.editorial_score - a.editorial_score || a.id.localeCompare(b.id));
  const selected = ranked[0];
  let selectedFeature: TimelineFeature | null = null;
  if (selected) {
    const primary = (selected.event_type === "turnover" ? selected.involved_starters.find((p) => p.role === "fumbled_1" || p.role === "fumbled_2")
      ?? selected.involved_starters.find((p) => p.role === "passer") : undefined)
      ?? selected.involved_starters.find((p) => p.role === "rusher")
      ?? selected.involved_starters.find((p) => p.role === "receiver") ?? selected.involved_starters[0];
    selectedFeature = { candidate_id: selected.id,
      title: selected.event_type === "turnover" ? `A turnover on a play involving ${primary.name}`
        : `${primary.name}: ${selected.yards}-yard ${selected.event_type === "touchdown" ? "touchdown" : "gain"}`,
      summary: selected.description, player_name: primary.name, team_id: primary.team_id, quarter: selected.quarter,
      clock: selected.clock, source_url: sourceUrl, selection_basis: selected.ranking_reasons, evidence_kind: "nfl_play_only" };
    const v = verified as { season?: number; week?: number; lead?: Record<string, unknown> } | undefined;
    const lead = v?.lead;
    if (v?.season === report.season && v.week === report.week && lead
      && `${lead.nfl_game_id}:${lead.play_id}` === selected.id && lead.player_name === primary.name
      && lead.team_id === primary.team_id && typeof lead.fantasy_points === "number" && Number.isFinite(lead.fantasy_points)
      && typeof lead.title === "string" && typeof lead.summary === "string") {
      const matchup = matchups.find((m) => m.teams.some((t) => t.id === primary.team_id));
      const ids = matchup?.teams.map((t) => String(t.id)) ?? [];
      const before = lead.before as Record<string, unknown> | undefined, after = lead.after as Record<string, unknown> | undefined;
      if (ids.length === 2 && ids.every((id) => typeof before?.[id] === "number" && Number.isFinite(before[id])
        && typeof after?.[id] === "number" && Number.isFinite(after[id]))) {
        selectedFeature = { ...selectedFeature, title: clip(lead.title, 200), summary: clip(lead.summary),
          evidence_kind: "verified_featured_fantasy_scoring", fantasy_points: lead.fantasy_points,
          before: Object.fromEntries(ids.map((id) => [id, before![id] as number])),
          after: Object.fromEntries(ids.map((id) => [id, after![id] as number])) };
      }
    }
  }
  return { schema: "fantasy_week_timeline", version: 1, season: report.season, week: report.week,
    generated_at: new Date().toISOString(), source_report_generated_at: report.generatedAt,
    evidence_kind: "observed_nfl_sequence", source_url: sourceUrl, caveat: TIMELINE_CAVEAT,
    coverage: { nfl_games: games.length, raw_plays: rows.length, timed_plays: rows.filter((r) => validTime(r.time_of_day)).length,
      historical_starters: starters.size, mapped_starters: byGsis.size,
      starters_with_observed_games: [...starters.values()].filter((p) => p.nfl_games.length).length,
      candidate_count: candidates.length, fantasy_score_reconstruction: "featured_verified_play_only" },
    games, latest_game_id: latest?.id ?? null, latest_game_first_observed_at: latest?.first_observed_at ?? null,
    matchups, matchups_with_players_in_latest_window: matchups.filter((m) => m.remaining_starter_count > 0).length,
    moments: [...candidates].sort((a, b) => (a.observed_at ?? `${a.date}Z`).localeCompare(b.observed_at ?? `${b.date}Z`)
      || a.nfl_game_id.localeCompare(b.nfl_game_id) || number(a.play_id) - number(b.play_id)),
    ranking_method: "Heuristic candidate ordering for later story selection: +100 touchdown / +90 turnover / +30 long gain, then absolute recorded yards capped at 99 divided by 100. A turnover takes precedence over a simultaneous touchdown flag, including defensive return touchdowns. There is no day-of-week or recency bonus; ties use stable play ID. These are not fantasy-point values, win probabilities, or proof of a matchup swing. Only historical starters count; the story writer can choose a different candidate.",
    rankedCandidates: ranked, selectedFeature };
}

async function boundedRead(filename: string): Promise<string> {
  const handle = await fs.open(filename, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Timeline evidence exceeds the file size limit");
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const result = await handle.read(data, offset, data.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > stat.size) throw new Error("Timeline evidence changed while reading");
    return data.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}

export async function loadLeagueTimeline(root: string, report: LeagueWeek): Promise<LeagueTimeline> {
  const [mappingText, pbpText, verifiedText] = await Promise.all([
    boundedRead(path.join(root, "raw", "nflverse", "players.csv")),
    boundedRead(path.join(root, "raw", "nflverse", `play_by_play_${report.season}.csv`)),
    boundedRead(path.join(root, "out", "league", String(report.season), `week_${report.week}_moments.json`))
      .catch((error) => { if (error.code === "ENOENT") return "null"; throw error; }),
  ]);
  const parseCsv = (text: string) => parse(text, { columns: true, skip_empty_lines: true, bom: true, max_record_size: 128 * 1024 }) as Row[];
  return buildLeagueTimeline(report, parseCsv(mappingText), parseCsv(pbpText), JSON.parse(verifiedText));
}

export function compactLeagueTimeline(timeline: LeagueTimeline, teamId: number) {
  const matchup = timeline.matchups.find((m) => m.teams.some((t) => t.id === teamId));
  const ids = new Set(matchup?.teams.map((t) => t.id));
  const relevant = timeline.moments.filter((m) => m.involved_starters.some((p) => ids.has(p.team_id)));
  const gameHighlights = timeline.games.flatMap((game) => {
    const moment = timeline.rankedCandidates.find((m) => m.nfl_game_id === game.id);
    return moment ? [{ id: moment.id, nfl_game_id: game.id, observed_at: moment.observed_at,
      quarter: moment.quarter, clock: moment.clock, event_type: moment.event_type, yards: moment.yards,
      description: clip(moment.description, 350), involved_starters: moment.involved_starters.map((p) => ({
        name: p.name, team_id: p.team_id, role: p.role })) }] : [];
  });
  return { schema: timeline.schema, version: timeline.version, evidence_kind: timeline.evidence_kind,
    season: timeline.season, week: timeline.week, coverage: timeline.coverage, caveat: timeline.caveat,
    latest_game_id: timeline.latest_game_id, latest_game_first_observed_at: timeline.latest_game_first_observed_at,
    matchups_with_players_in_latest_window: timeline.matchups_with_players_in_latest_window,
    league_matchups_at_latest_game: timeline.matchups.map((m) => ({ matchup_id: m.id,
      timing_coverage_complete: m.timing_coverage_complete, teams: m.teams.map((t) => ({ id: t.id, name: t.name,
        points_before_latest_game: t.completed_points_before_latest_game,
        remaining_starters: t.remaining_starters.map((p) => p.name), unknown_starters: t.unknown_starters.map((p) => p.name) })) })),
    selected_matchup: matchup, games: timeline.games, ranking_method: timeline.ranking_method,
    selected_feature: timeline.selectedFeature, ranked_candidates: timeline.rankedCandidates.slice(0, 5),
    week_game_highlights: gameHighlights,
    week_game_highlights_note: "One highest-ranked notable starter play per NFL game, in observed game-start order; the full source artifact retains all notable plays. No per-play fantasy scoring is implied.",
    selected_matchup_sequence: relevant.slice(-12), selected_matchup_notable_play_count: relevant.length,
    sequence_limit_note: "At most the latest 12 notable plays for the selected matchup, in observed UTC order. This is not every snap or a reconstructed fantasy scoreboard.",
    source_url: timeline.source_url };
}
