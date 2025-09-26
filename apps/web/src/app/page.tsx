import {
  type MonteCarloSummary,
  type MonteCarloTeamSummary,
  type RestOfSeasonSimulation,
  type SimulationStanding,
  type SimulationTeamMeta,
  type SimulationTeamScheduleEntry,
  getLatestSimulation,
} from "@/lib/simulator-data";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatOwners(owners: string[]): string {
  if (owners.length === 0) return "Unclaimed";
  if (owners.length === 1) return owners[0];
  if (owners.length === 2) return `${owners[0]} & ${owners[1]}`;
  return `${owners[0]}, ${owners[1]} +`;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRecord(record: SimulationStanding["projected_record"]): string {
  return `${record.wins.toFixed(1)} – ${record.losses.toFixed(1)}`;
}

function probabilityClass(probability: number): string {
  if (probability >= 0.6) return "cell cell--favorable";
  if (probability <= 0.4) return "cell cell--underdog";
  return "cell cell--coinflip";
}

function probabilityLabel(probability: number): string {
  const pct = Math.round(probability * 100);
  return `${pct}% win odds`;
}

function formatMargin(margin: number): string {
  if (Number.isNaN(margin)) return "";
  if (Math.abs(margin) < 0.25) return "coin flip";
  if (margin > 0) return `favored by ${margin.toFixed(1)}`;
  return `needs ${Math.abs(margin).toFixed(1)}`;
}

function buildScheduleIndex(
  teamSchedule: RestOfSeasonSimulation["team_schedule"],
): Map<number, Map<number, SimulationTeamScheduleEntry>> {
  const index = new Map<number, Map<number, SimulationTeamScheduleEntry>>();
  for (const [teamIdRaw, entries] of Object.entries(teamSchedule)) {
    const teamId = Number(teamIdRaw);
    if (!Number.isFinite(teamId)) continue;
    const weekMap = new Map<number, SimulationTeamScheduleEntry>();
    for (const entry of entries) {
      weekMap.set(entry.week, entry);
    }
    index.set(teamId, weekMap);
  }
  return index;
}

function buildMonteCarloIndex(
  monteCarlo?: MonteCarloSummary,
): Map<number, MonteCarloTeamSummary> | null {
  if (!monteCarlo) {
    return null;
  }
  const map = new Map<number, MonteCarloTeamSummary>();
  for (const entry of monteCarlo.teams) {
    map.set(entry.team.team_id, entry);
  }
  return map;
}

function WeekHeader({ weeks }: { weeks: number[] }) {
  return (
    <thead>
      <tr>
        <th scope="col">Team Outlook</th>
        {weeks.map((week) => (
          <th key={week} scope="col">
            Week {week}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function TeamRow({
  team,
  record,
  weeks,
  scheduleIndex,
  teamsById,
  monteCarlo,
}: {
  team: SimulationTeamMeta;
  record: SimulationStanding["projected_record"];
  weeks: number[];
  scheduleIndex: Map<number, Map<number, SimulationTeamScheduleEntry>>;
  teamsById: Map<number, SimulationTeamMeta>;
  monteCarlo?: Map<number, MonteCarloTeamSummary> | null;
}) {
  const weeklyMap = scheduleIndex.get(team.team_id) ?? new Map();
  const mc = monteCarlo?.get(team.team_id ?? -1) ?? null;
  const playoffCopy = mc ? `${Math.round(mc.playoff_odds * 100)}% playoff odds` : null;
  const seedCopy = mc && mc.top_seed_odds > 0.01 ? `${Math.round(mc.top_seed_odds * 100)}% for #1 seed` : null;
  const avgWinsCopy = mc ? `${mc.average_wins.toFixed(1)} avg wins` : null;
  return (
    <tr>
      <th scope="row">
        <div className="team-heading">
          <span className="team-heading__name">{team.name}</span>
          <div className="team-heading__meta">
            <span className="team-heading__record">{formatRecord(record)}</span>
            {avgWinsCopy ? <span className="team-heading__avg">{avgWinsCopy}</span> : null}
            {playoffCopy ? <span className="team-heading__prob">{playoffCopy}</span> : null}
            {seedCopy ? <span className="team-heading__seed">{seedCopy}</span> : null}
          </div>
          <span className="team-heading__owners">{formatOwners(team.owners)}</span>
        </div>
      </th>
      {weeks.map((week) => {
        const entry = weeklyMap.get(week);
        if (!entry) {
          return (
            <td key={week} className="cell cell--empty">
              —
            </td>
          );
        }
        const opponent = teamsById.get(entry.opponent_team_id);
        const opponentLabel = opponent ? opponent.abbrev || opponent.name : `Team ${entry.opponent_team_id}`;
        const direction = entry.is_home ? "vs" : "@";
        const cellClass = probabilityClass(entry.win_probability);
        const winPct = Math.round(entry.win_probability * 100);
        const marginCopy = formatMargin(entry.projected_margin);
        return (
          <td key={week} className={`cell ${cellClass}`}>
            <div className="cell__body">
              <div className="cell__points">{entry.projected_points.toFixed(1)} pts</div>
              <div className="cell__opponent-row">
                <span className="cell__opponent-dir">{direction}</span>
                <span className="cell__opponent-name">{opponentLabel}</span>
                <span className="cell__opponent-opp">{entry.opponent_projected_points.toFixed(1)} pts</span>
              </div>
              <div className="cell__margin">{marginCopy}</div>
              <div className="cell__prob">
                <span className="cell__prob-value">{probabilityLabel(entry.win_probability)}</span>
                <div className="cell__prob-bar">
                  <span style={{ width: `${winPct}%` }} />
                </div>
              </div>
            </div>
          </td>
        );
      })}
    </tr>
  );
}

export default async function Home() {
  const simulation = await getLatestSimulation();

  if (!simulation) {
    return (
      <main className="shell">
        <section className="empty-state">
          <h1>No simulation artifacts yet</h1>
          <p>
            Kick off a backend refresh to build the rest-of-season projection grid. Run
            <code>poetry run fantasy refresh-all</code> and then reload this page.
          </p>
        </section>
      </main>
    );
  }

  const standings = simulation.standings;
  const orderedTeams = standings.map((entry) => entry.team);
  const weeks = [...new Set(simulation.weeks.map((week) => week.week))].sort((a, b) => a - b);
  const teamsById = new Map(simulation.teams.map((team) => [team.team_id, team] as const));
  const scheduleIndex = buildScheduleIndex(simulation.team_schedule);
  const monteCarlo = simulation.monte_carlo;
  const monteCarloIndex = buildMonteCarloIndex(monteCarlo);

  return (
    <main className="shell">
      <section className="panel matrix-panel">
        <header className="matrix-header">
          <div className="matrix-header__left">
            <h1>Season {simulation.season} · Weeks {simulation.start_week}–{simulation.end_week}</h1>
            <span>Generated {formatTimestamp(simulation.generated_at)} · {simulation.weeks.length} weeks · {simulation.teams.length} teams</span>
          </div>
          {monteCarlo ? (
            <div className="matrix-header__stats">
              <span>{monteCarlo.iterations.toLocaleString()} Monte Carlo runs</span>
              <span>{monteCarlo.playoff_slots} playoff slots</span>
              {monteCarlo.random_seed !== null ? <span>Seed {monteCarlo.random_seed}</span> : null}
            </div>
          ) : null}
        </header>
        <div className="matrix-wrapper">
          <table className="sim-matrix">
            <WeekHeader weeks={weeks} />
            <tbody>
              {orderedTeams.map((team, index) => (
                <TeamRow
                  key={team.team_id}
                  team={team}
                  record={standings[index].projected_record}
                  weeks={weeks}
                  scheduleIndex={scheduleIndex}
                  teamsById={teamsById}
                  monteCarlo={monteCarloIndex}
                />
              ))}
            </tbody>
          </table>
        </div>
        <footer className="legend">
          <span>
            <span className="legend__swatch legend__swatch--favorable" /> Favorable (&gt;60% win odds)
          </span>
          <span>
            <span className="legend__swatch legend__swatch--coinflip" /> Tight contest (40–60%)
          </span>
          <span>
            <span className="legend__swatch legend__swatch--underdog" /> Underdog (&lt;40% win odds)
          </span>
        </footer>
      </section>
    </main>
  );
}
