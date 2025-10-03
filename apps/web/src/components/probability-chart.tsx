"use client";

import clsx from "clsx";
import { useMemo } from "react";

export type ProbabilityPoint = {
  timestamp: string;
  probability: number;
};

const WIDTH = 600;
const HEIGHT = 220;
const MID_Y = HEIGHT / 2;
const MIN_LABEL_GAP = 0.08;

interface AxisLabel {
  key: string;
  ratio: number;
  primary: string;
  secondary?: string;
  variant: "start" | "mid" | "end";
}

export function ProbabilityChart({ points }: { points: ProbabilityPoint[] }) {
  const fullFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    [],
  );
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    [],
  );
  const dayFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    [],
  );

  const chart = useMemo(() => {
    if (!points.length) {
      return null;
    }

    const entries = points
      .map((point, index) => {
        const time = Date.parse(point.timestamp);
        if (!Number.isFinite(time)) {
          return null;
        }
        return {
          index,
          time,
          probability: point.probability,
        };
      })
      .filter((entry): entry is { index: number; time: number; probability: number } => entry !== null);

    if (!entries.length) {
      return null;
    }

    const duration = Math.max(entries[entries.length - 1].time - entries[0].time, 1);
    const step = entries.length > 1 ? WIDTH / (entries.length - 1) : WIDTH;

    const homeCoords = entries.map(({ probability }, index) => {
      const x = Math.round(index * step);
      const y = Math.round(MID_Y - (probability - 0.5) * HEIGHT);
      return { x, y };
    });

    const awayCoords = homeCoords.map(({ x, y }) => ({ x, y: MID_Y * 2 - y }));

    const buildLine = (coords: { x: number; y: number }[]) =>
      coords
        .map((coord, index) => `${index === 0 ? "M" : "L"} ${coord.x} ${coord.y}`)
        .join(" ");

    const homeLine = buildLine(homeCoords);
    const awayLine = buildLine(awayCoords);
    const homeArea = `${homeLine} L ${homeCoords[homeCoords.length - 1].x} ${MID_Y} L ${homeCoords[0].x} ${MID_Y} Z`;
    const awayArea = `${awayLine} L ${awayCoords[awayCoords.length - 1].x} ${MID_Y} L ${awayCoords[0].x} ${MID_Y} Z`;

    const axisLabels: AxisLabel[] = [];
    const startTime = entries[0].time;
    const endTime = entries[entries.length - 1].time;

    const startDate = new Date(startTime);
    axisLabels.push({
      key: `start-${startTime}`,
      ratio: 0,
      primary: fullFormatter.format(startDate),
      secondary: timeFormatter.format(startDate),
      variant: "start",
    });

    if (endTime > startTime) {
      const dayAnchors = new Map<string, number>();
      for (const entry of entries) {
        const localDate = new Date(entry.time);
        const key = `${localDate.getFullYear()}-${localDate.getMonth()}-${localDate.getDate()}`;
        if (!dayAnchors.has(key)) {
          dayAnchors.set(key, entry.time);
        }
      }

      const sortedAnchors = Array.from(dayAnchors.values()).sort((a, b) => a - b);
      for (const anchor of sortedAnchors) {
        if (anchor <= startTime + 1) continue;
        if (anchor >= endTime - 1) continue;
        const ratio = Math.min(1, Math.max(0, (anchor - startTime) / duration));
        const anchorDate = new Date(anchor);
        const tooClose = axisLabels.some(
          (label) => label.variant === "mid" && Math.abs(label.ratio - ratio) < MIN_LABEL_GAP,
        );
        if (!tooClose) {
          axisLabels.push({
            key: `day-${anchor}`,
            ratio,
            primary: dayFormatter.format(anchorDate),
            variant: "mid",
          });
        }
      }

      const endDate = new Date(endTime);
      axisLabels.push({
        key: `end-${endTime}`,
        ratio: 1,
        primary: fullFormatter.format(endDate),
        secondary: timeFormatter.format(endDate),
        variant: "end",
      });
    }

    return {
      homeLine,
      awayLine,
      homeArea,
      awayArea,
      axisLabels,
    };
  }, [points, fullFormatter, dayFormatter, timeFormatter]);

  if (!chart) {
    return null;
  }

  return (
    <div className="grid gap-1.5">
      <svg className="h-40 w-full" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
        <line
          x1={0}
          y1={MID_Y}
          x2={WIDTH}
          y2={MID_Y}
          stroke="rgba(148,163,184,0.4)"
          strokeWidth={1}
          strokeDasharray="4 6"
        />
        <path
          d={chart.awayArea}
          fill="var(--accent-warn)"
          fillOpacity={0.25}
        />
        <path
          d={chart.homeArea}
          fill="var(--accent)"
          fillOpacity={0.25}
        />
        <path
          d={chart.homeLine}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2.5}
        />
        <path
          d={chart.awayLine}
          fill="none"
          stroke="var(--accent-warn)"
          strokeWidth={2.5}
          strokeOpacity={0.7}
        />
      </svg>
      <div className="relative h-11 text-[0.78rem] text-[var(--text-muted)] pointer-events-none" aria-hidden="true">
        {chart.axisLabels.map((tick) => (
          <span
            key={tick.key}
            className={clsx(
              "absolute top-0 flex -translate-x-1/2 flex-col gap-0.5 whitespace-nowrap tracking-[0.05em]",
              tick.variant === "start" && "translate-x-0 items-start text-left",
              tick.variant === "end" && "translate-x-[-100%] items-end text-right",
              tick.variant === "mid" && "items-center text-center",
            )}
            style={{ left: tick.variant === "end" ? "100%" : `${tick.ratio * 100}%` }}
          >
            <span className="font-semibold">{tick.primary}</span>
            {tick.secondary ? (
              <span className="text-[0.72rem] opacity-80">{tick.secondary}</span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}
