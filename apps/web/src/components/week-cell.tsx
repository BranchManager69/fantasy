import clsx from "clsx";
import Link from "next/link";
import {
  formatFinalMargin,
  formatLiveMargin,
  formatMargin,
  probabilityLabel,
  probabilityTone,
} from "@/lib/formatters";
import type { TeamScheduleWithContext } from "@/lib/simulator-data";

interface WeekCellProps {
  entry: TeamScheduleWithContext | undefined;
  week: number;
  scenarioId?: string;
}

export function WeekCell({ entry, week, scenarioId }: WeekCellProps) {
  if (!entry) {
    return (
      <td className="align-top border-b border-[rgba(148,163,184,0.12)] border-r border-[rgba(148,163,184,0.08)]">
        <div className="grid place-items-center px-4 py-6 text-sm text-[var(--text-muted)]">—</div>
      </td>
    );
  }

  const opponent = entry.opponent;
  const opponentLabel = opponent ? opponent.abbrev || opponent.name : `Team ${entry.opponent_team_id}`;
  const opponentHref = opponent ? `/teams/${opponent.team_id}` : null;
  const direction = entry.is_home ? "vs" : "@";
  const isActual = entry.isActual;
  const status = entry.status ?? (isActual ? (entry.result ? "final" : "in_progress") : "upcoming");
  const isLive = isActual && status === "in_progress";
  const isFinal = isActual && status === "final";

  const pointsFor = isActual ? entry.actualPoints ?? entry.projected_points : entry.projected_points;
  const pointsAgainst = isActual
    ? entry.opponentActualPoints ?? entry.opponent_projected_points
    : entry.opponent_projected_points;

  const actualMargin =
    entry.actualPoints !== null && entry.opponentActualPoints !== null
      ? entry.actualPoints - entry.opponentActualPoints
      : entry.projected_margin;

  const marginCopy = isActual
    ? isLive
      ? formatLiveMargin(entry.actualPoints, entry.opponentActualPoints)
      : formatFinalMargin(actualMargin ?? 0)
    : formatMargin(entry.projected_margin);

  const winPct = Math.round(entry.win_probability * 100);
  const rawProbabilityDelta =
    typeof entry.winProbabilityDelta === "number" ? entry.winProbabilityDelta : null;
  const showProbabilityDelta = rawProbabilityDelta !== null && Math.abs(rawProbabilityDelta) >= 0.1;
  const probabilityDeltaCopy = showProbabilityDelta
    ? `${rawProbabilityDelta >= 0 ? "+" : ""}${Math.abs(rawProbabilityDelta) >= 1 ? rawProbabilityDelta.toFixed(0) : rawProbabilityDelta.toFixed(1)}`
    : null;
  const probabilityDeltaTrend = showProbabilityDelta ? (rawProbabilityDelta! > 0 ? "up" : "down") : null;

  const matchupId = entry.matchup_id ?? entry.matchup?.matchup_id ?? null;
  const targetWeek = entry.week ?? week;
  const scenarioQuery = scenarioId ? `?scenario=${encodeURIComponent(scenarioId)}` : "";
  const matchupHref = matchupId !== null ? `/matchups/${targetWeek}/${encodeURIComponent(matchupId)}${scenarioQuery}` : null;
  const allowOpponentLink = opponentHref && !matchupHref;

  const toneClass = isActual
    ? isLive
      ? "bg-[rgba(30,64,175,0.18)]"
      : entry.result === "win"
        ? "bg-[rgba(34,197,94,0.12)]"
        : entry.result === "loss"
          ? "bg-[rgba(239,68,68,0.12)]"
          : "bg-[rgba(148,163,184,0.12)]"
    : "";
  const toneKey = probabilityTone(entry.win_probability);

  const toneStyle = !isActual
    ? toneKey === "favorable"
      ? {
          background: "linear-gradient(135deg, rgba(34,197,94,0.25) 0%, rgba(15,24,45,0.1) 100%)",
        }
      : toneKey === "underdog"
        ? {
            background: "linear-gradient(135deg, rgba(239,68,68,0.25) 0%, rgba(15,24,45,0.1) 100%)",
          }
        : {
            background: "linear-gradient(135deg, rgba(59,130,246,0.18) 0%, rgba(15,24,45,0.08) 100%)",
          }
    : undefined;

  const wrapperClass = "grid gap-3 p-4";

  const body = (
    <div className={wrapperClass}>
      <div className="flex items-center justify-between gap-4">
        <div className="text-[1.1rem] font-semibold text-[var(--text-primary)] tabular-nums">
          {pointsFor.toFixed(1)}
        </div>
        <div className="flex items-baseline gap-2 text-sm text-[var(--text-muted)]">
          <span className="text-xs uppercase tracking-[0.14em] text-[var(--accent)]">{direction}</span>
          {allowOpponentLink ? (
            <Link href={opponentHref!} className="truncate text-sm text-[var(--text-soft)]">
              {opponentLabel}
            </Link>
          ) : (
            <span className="truncate text-sm text-[var(--text-soft)]">{opponentLabel}</span>
          )}
          <span className="text-[var(--text-muted)] tabular-nums">{pointsAgainst.toFixed(1)}</span>
        </div>
      </div>

      <div className="grid gap-2 text-sm text-[var(--text-muted)]">
        <div className="uppercase tracking-[0.12em] text-xs text-[var(--text-soft)]">{marginCopy}</div>

        {!isFinal ? (
          <div className="grid gap-1">
            <div className="flex items-center justify-between text-[0.7rem] uppercase tracking-[0.16em] text-[var(--text-muted)]">
              <span>{probabilityLabel(entry.win_probability)}</span>
              {probabilityDeltaCopy && probabilityDeltaTrend ? (
                <span
                  className={clsx(
                    "flex items-center gap-1 text-xs",
                    probabilityDeltaTrend === "up" && "text-[var(--accent-strong)]",
                    probabilityDeltaTrend === "down" && "text-[var(--accent-warn)]",
                  )}
                >
                  {probabilityDeltaTrend === "up" ? "▲" : "▼"} {probabilityDeltaCopy}
                </span>
              ) : null}
            </div>
            <div className="h-2 rounded-full bg-[rgba(148,163,184,0.2)]">
              <span
                className="block h-full rounded-full bg-gradient-to-r from-[rgba(96,165,250,0.9)] to-[rgba(45,212,191,0.8)]"
                style={{ width: `${winPct}%` }}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-[var(--text-muted)]">
        <span>{isFinal ? "Final" : isLive ? "Live" : "Projected"}</span>
        <span>Week {targetWeek}</span>
      </div>
    </div>
  );

  return (
    <td
      className={clsx(
        "align-top border-b border-[rgba(148,163,184,0.12)] border-r border-[rgba(148,163,184,0.08)] transition",
        toneClass,
      )}
      style={{ minWidth: 220, width: 220, ...(toneStyle ?? {}) }}
    >
      {matchupHref ? (
        <Link href={matchupHref} className="block rounded-[var(--radius-sm)] hover:bg-[rgba(15,23,42,0.35)]">
          {body}
        </Link>
      ) : (
        body
      )}
    </td>
  );
}
