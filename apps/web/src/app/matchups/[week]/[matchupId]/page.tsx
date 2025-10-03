import { notFound } from "next/navigation";
import { promises as fs } from "node:fs";

import { AppNav } from "@/components/app-nav";
import { ProbabilityChart, type ProbabilityPoint } from "@/components/probability-chart";
import {
  buildSimulationLookup,
  getLatestSimulation,
  getPreviousSimulationSnapshot,
  listSimulationHistorySnapshots,
  readSimulationFile,
  getTeamSchedule,
  type SimulationLookup,
  type RestOfSeasonSimulation,
  type TeamScheduleWithContext,
  type SimulationPlayer,
} from "@/lib/simulator-data";
import { scoreboardPath, refreshDiffLogPath } from "@/lib/paths";
import { normalizeScenarioId } from "@/lib/scenario-utils";
import {
  formatFinalMargin,
  formatLiveMargin,
  formatMargin,
  formatOwners,
  probabilityLabel,
} from "@/lib/formatters";

const MAX_DIFF_ENTRIES = 12;
const MAX_TIMELINE_POINTS = 600;
const MAX_CHART_POINTS = 200;
const MIN_TIMELINE_STEP_MS = 5 * 60 * 1000;
const MAX_TIMELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MatchupPage({
  params,
  searchParams,
}: {
  params: Promise<{ week?: string; matchupId?: string }>;
  searchParams?: Promise<{ scenario?: string }>;
}) {
  const resolvedParams = await params;
  const resolvedSearch = searchParams ? await searchParams : undefined;

  const weekRaw = resolvedParams.week ?? "";
  const matchupId = resolvedParams.matchupId ?? "";
  const week = Number.parseInt(weekRaw, 10);
  if (!Number.isFinite(week) || week <= 0 || !matchupId) {
    notFound();
  }

  const requestedScenario = normalizeScenarioId(resolvedSearch?.scenario);

  let simulation = await getLatestSimulation(requestedScenario);
  let activeScenarioId: string | undefined = requestedScenario;
  if (!simulation && requestedScenario) {
    simulation = await getLatestSimulation();
    activeScenarioId = undefined;
  }

  if (!simulation) {
    notFound();
  }

  const lookup = buildSimulationLookup(simulation);
  const matchup = lookup.matchupsById.get(matchupId);
  if (!matchup || matchup.week !== week) {
    notFound();
  }

  const previousSimulation = await getPreviousSimulationSnapshot(simulation, activeScenarioId);
  const previousLookup: SimulationLookup | null = previousSimulation ? buildSimulationLookup(previousSimulation) : null;
  const deltaContext = previousSimulation && previousLookup
    ? {
        simulation: previousSimulation,
        lookup: previousLookup,
      }
    : undefined;

  const homeSchedule = getTeamSchedule(simulation, matchup.home.team.team_id, lookup, deltaContext);
  const awaySchedule = getTeamSchedule(simulation, matchup.away.team.team_id, lookup, deltaContext);
  const homeEntry = findScheduleEntry(homeSchedule, week, matchupId);
  const awayEntry = findScheduleEntry(awaySchedule, week, matchupId);

  const [timeline, scoreboard, diffEntries] = await Promise.all([
    buildProbabilityTimeline(simulation, activeScenarioId, matchupId),
    loadScoreboard(simulation.season, week),
    loadRecentDiffs([
      matchup.home.team.team_id,
      matchup.away.team.team_id,
    ]),
  ]);

  const homeScore = getScoreSnapshot(homeEntry, scoreboard.teamTotals.get(matchup.home.team.team_id));
  const awayScore = getScoreSnapshot(awayEntry, scoreboard.teamTotals.get(matchup.away.team.team_id));

  const probabilityDelta = homeEntry?.winProbabilityDelta ?? null;

  const marginCopy = buildMarginCopy(homeEntry, matchup.home_win_probability, matchup.projected_margin);

  return (
    <main className="shell">
      <AppNav />
      <section className="grid gap-8 p-8">
        <header className="grid gap-6 rounded-[var(--radius-lg)] border border-[rgba(148,163,184,0.18)] bg-[rgba(15,23,42,0.65)] p-6 lg:grid-cols-3 lg:items-center">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">{matchup.home.team.name}</h1>
            <p className="text-sm text-[var(--text-muted)]">{formatOwners(matchup.home.team.owners)}</p>
          </div>
          <div className="flex items-baseline justify-center gap-3 text-3xl font-bold">
            <span className="tabular-nums">{homeScore.actual.toFixed(1)}</span>
            <span className="text-lg text-[var(--text-muted)]">–</span>
            <span className="tabular-nums">{awayScore.actual.toFixed(1)}</span>
          </div>
          <div className="space-y-1 text-right lg:text-left">
            <h1 className="text-xl font-semibold">{matchup.away.team.name}</h1>
            <p className="text-sm text-[var(--text-muted)]">{formatOwners(matchup.away.team.owners)}</p>
          </div>
        </header>

        <section className="grid gap-4 rounded-[var(--radius-lg)] border border-[rgba(148,163,184,0.12)] bg-[rgba(13,23,42,0.7)] p-6">
          <h2 className="text-lg font-semibold">Win Probability</h2>
          <div className="grid gap-3">
            <div className="flex items-baseline gap-3">
              <span className="text-xl font-semibold">{probabilityLabel(matchup.home_win_probability)}</span>
              {probabilityDelta !== null ? (
                <span
                  className={`text-xs uppercase tracking-[0.08em] ${probabilityDelta >= 0 ? "text-[var(--accent-strong)]" : "text-[var(--accent-warn)]"}`}
                >
                  {probabilityDelta >= 0 ? "▲" : "▼"} {formatProbabilityDelta(probabilityDelta)}
                </span>
              ) : null}
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-[rgba(148,163,184,0.2)]">
              <span
                className="block h-full"
                style={{
                  width: `${Math.round(matchup.home_win_probability * 100)}%`,
                  background: "linear-gradient(90deg, rgba(96, 165, 250, 0.9), rgba(45, 212, 191, 0.8))",
                }}
              />
            </div>
            <p className="text-sm uppercase tracking-[0.08em] text-[var(--text-muted)]">{marginCopy}</p>
            {timeline.length > 1 ? <ProbabilityChart points={timeline} /> : null}
          </div>
        </section>

        <section className="grid gap-4 rounded-[var(--radius-lg)] border border-[rgba(148,163,184,0.12)] bg-[rgba(13,23,42,0.7)] p-6">
          <h2 className="text-lg font-semibold">Lineups</h2>
          <div className="grid gap-6 md:grid-cols-2">
            <RosterColumn
              title={matchup.home.team.name}
              starters={matchup.home.starters}
              bench={matchup.home.bench}
              livePlayers={scoreboard.players.get(matchup.home.team.team_id) ?? []}
            />
            <RosterColumn
              title={matchup.away.team.name}
              starters={matchup.away.starters}
              bench={matchup.away.bench}
              livePlayers={scoreboard.players.get(matchup.away.team.team_id) ?? []}
            />
          </div>
        </section>

        <section className="grid gap-4 rounded-[var(--radius-lg)] border border-[rgba(148,163,184,0.12)] bg-[rgba(13,23,42,0.7)] p-6">
          <h2 className="text-lg font-semibold">Latest Swings</h2>
          {diffEntries.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">No recent scoring updates yet.</p>
          ) : (
            <ul className="grid gap-3">
              {diffEntries.map((entry) => (
                <li
                  key={entry.finishedAt}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-2"
                >
                  <span className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">
                    {new Date(entry.finishedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                  </span>
                  {entry.teamDiffs.map((diff, index) => (
                    <span key={`team-${index}`} className="inline-flex items-baseline gap-1 text-sm">
                      <strong className="font-semibold">{diff.abbrev ?? diff.name ?? `Team ${diff.teamId}`}</strong>
                      <span>{formatDelta(diff.delta)}</span>
                    </span>
                  ))}
                  {entry.playerDiffs.map((diff, index) => (
                    <span key={`player-${index}`} className="inline-flex items-baseline gap-1 text-sm">
                      <strong className="font-semibold">{diff.playerName}</strong>
                      <span>{formatDelta(diff.delta)}</span>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>
      </section>
    </main>
  );
}

function findScheduleEntry(schedule: TeamScheduleWithContext[], week: number, matchupId: string) {
  return schedule.find((entry) => entry.week === week && entry.matchup_id === matchupId) ?? null;
}

function getScoreSnapshot(entry: TeamScheduleWithContext | null, liveTotal: number | undefined) {
  const projected = entry ? entry.projected_points : 0;
  const actual = entry && entry.actualPoints !== null ? entry.actualPoints : liveTotal ?? projected;
  return { projected, actual };
}

function buildMarginCopy(entry: TeamScheduleWithContext | null, winProb: number, projectedMargin: number) {
  if (!entry) {
    return formatMargin(projectedMargin);
  }
  if (entry.isActual) {
    if (entry.status === "final") {
      const margin = (entry.actualPoints ?? 0) - (entry.opponentActualPoints ?? 0);
      return formatFinalMargin(margin);
    }
    return formatLiveMargin(entry.actualPoints, entry.opponentActualPoints);
  }
  return formatMargin(entry.projected_margin ?? projectedMargin);
}

function formatProbabilityDelta(delta: number) {
  const value = Math.abs(delta);
  return value >= 1 ? value.toFixed(0) : value.toFixed(1);
}

function formatDelta(delta: number) {
  const formatted = Math.abs(delta) >= 1 ? delta.toFixed(0) : delta.toFixed(1);
  return `${delta >= 0 ? "+" : ""}${formatted}`;
}

async function loadScoreboard(season: number, week: number) {
  const file = scoreboardPath(season, week);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const data = JSON.parse(raw);
    const teamTotals = new Map<number, number>();
    const players = new Map<number, { name: string; points: number }[]>();

    for (const matchup of data?.schedule ?? []) {
      for (const side of ["home", "away"] as const) {
        const team = matchup?.[side];
        if (!team || team.teamId == null) continue;
        const teamId = Number(team.teamId);
        const total = Number(team.totalPointsLive ?? team.totalPoints ?? 0);
        if (Number.isFinite(total)) {
          teamTotals.set(teamId, total);
        }

        const rosterEntries = team.rosterForMatchupPeriod?.entries ?? [];
        for (const entry of rosterEntries) {
          const playerTotal = entry?.playerPoolEntry?.appliedStatTotal;
          const playerName = entry?.playerPoolEntry?.player?.fullName ?? entry?.playerPoolEntry?.player?.lastName;
          if (!playerName || !Number.isFinite(playerTotal) || playerTotal === 0) continue;
          const list = players.get(teamId) ?? [];
          list.push({ name: playerName, points: playerTotal });
          players.set(teamId, list);
        }
      }
    }

    return {
      teamTotals,
      players,
    };
  } catch {
    return { teamTotals: new Map<number, number>(), players: new Map<number, { name: string; points: number }[]>() };
  }
}

async function loadRecentDiffs(teamIds: number[]) {
  const file = refreshDiffLogPath();
  try {
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const selected = [] as DiffEntry[];
    for (let i = lines.length - 1; i >= 0 && selected.length < MAX_DIFF_ENTRIES; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]) as DiffEntry;
        const matches = parsed.teamDiffs.some((diff) => diff.teamId && teamIds.includes(diff.teamId))
          || parsed.playerDiffs.some((diff) => diff.teamId && teamIds.includes(diff.teamId!));
        if (matches) {
          selected.push(parsed);
        }
      } catch {
        continue;
      }
    }
    return selected.reverse();
  } catch {
    return [];
  }
}

async function buildProbabilityTimeline(
  simulation: RestOfSeasonSimulation,
  scenarioId: string | undefined,
  matchupId: string,
) {
  const currentTime = Date.parse(simulation.generated_at);
  const lookup = buildSimulationLookup(simulation);
  const currentMatchup = lookup.matchupsById.get(matchupId);
  if (!currentMatchup || !Number.isFinite(currentTime)) {
    return [];
  }

  const points: ProbabilityPoint[] = [
    { timestamp: simulation.generated_at, probability: currentMatchup.home_win_probability },
  ];

  const historyEntries = await listSimulationHistorySnapshots(simulation, scenarioId, {
    limit: MAX_TIMELINE_POINTS,
  });

  let lastTime = currentTime;
  let lastProbability = currentMatchup.home_win_probability;

  for (const entry of historyEntries) {
    if (points.length >= MAX_TIMELINE_POINTS) break;
    if (lastTime - entry.timestamp > MAX_TIMELINE_WINDOW_MS) break;

    const dataset = await readSimulationFile(entry.path);
    if (!dataset) continue;

    const lookupPrev = buildSimulationLookup(dataset);
    const matchupPrev = lookupPrev.matchupsById.get(matchupId);
    if (!matchupPrev) continue;

    const probability = matchupPrev.home_win_probability;
    const timeDiff = Math.abs(lastTime - entry.timestamp);
    if (timeDiff < MIN_TIMELINE_STEP_MS) {
      continue;
    }

    points.push({ timestamp: dataset.generated_at, probability });
    lastTime = entry.timestamp;
    lastProbability = probability;
  }

  const ordered = points.reverse();
  if (ordered.length <= 1) {
    const single = ordered[0];
    const duplicate = single
      ? [{ ...single, timestamp: new Date(new Date(single.timestamp).getTime() - MIN_TIMELINE_STEP_MS).toISOString() }, single]
      : [];
    return duplicate;
  }

  if (ordered.length <= MAX_CHART_POINTS) {
    return ordered;
  }

  const step = Math.ceil(ordered.length / MAX_CHART_POINTS);
  const downsampled: ProbabilityPoint[] = [];
  for (let i = 0; i < ordered.length; i += step) {
    downsampled.push(ordered[i]);
  }
  if (downsampled[downsampled.length - 1]?.timestamp !== ordered[ordered.length - 1]?.timestamp) {
    downsampled.push(ordered[ordered.length - 1]);
  }
  return downsampled;
}

function RosterColumn({
  title,
  starters,
  bench,
  livePlayers,
}: {
  title: string;
  starters: SimulationPlayer[];
  bench: SimulationPlayer[];
  livePlayers: { name: string; points: number }[];
}) {
  const liveMap = new Map(livePlayers.map((entry) => [entry.name, entry.points]));
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">{title}</h3>
      <div className="space-y-2">
        <h4 className="text-xs uppercase tracking-[0.1em] text-[var(--text-muted)]">Starters</h4>
        {starters.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No starters found.</p> : (
          <ul className="grid gap-1.5">
            {starters.map((player) => (
              <li key={`${player.espn_player_id}-${player.lineup_slot}`}>
                <span className="font-medium">{player.player_name}</span>
                <span className="ml-2 text-[var(--text-muted)] tabular-nums">
                  {player.projected_points.toFixed(1)}
                  {liveMap.has(player.player_name) ? ` / ${liveMap.get(player.player_name)!.toFixed(1)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2">
        <h4 className="text-xs uppercase tracking-[0.1em] text-[var(--text-muted)]">Bench</h4>
        {bench.length === 0 ? <p className="text-sm text-[var(--text-muted)]">Bench empty.</p> : (
          <ul className="grid gap-1.5">
            {bench.map((player) => (
              <li key={`${player.espn_player_id}-${player.lineup_slot}`}>
                <span className="font-medium">{player.player_name}</span>
                <span className="ml-2 text-[var(--text-muted)] tabular-nums">{player.projected_points.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface DiffEntry {
  finishedAt: string;
  teamDiffs: Array<{ teamId?: number | null; abbrev?: string | null; name?: string | null; delta: number }>;
  playerDiffs: Array<{ teamId?: number | null; playerName: string; delta: number }>;
}
