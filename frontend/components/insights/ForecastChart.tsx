"use client";

import { useState } from "react";

import { buildBandPath, buildPath, keepIndices, makeScaleX, makeScaleY, monthTickPositions, yDomain } from "@/lib/chart";
import { DateText, money, twinDate } from "@/lib/format";
import type { ForecastCallout, ScenarioBands } from "@/lib/types";

const W = 720;
const H = 270;
const PAD = { top: 20, right: 18, bottom: 28, left: 58 };

export function ForecastChart({ bands, callouts, asOf }: {
  bands: ScenarioBands;
  callouts: ForecastCallout[];
  asOf: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const points = bands.total;
  if (points.length < 2) return <p className="text-sm text-muted">No projection available.</p>;

  const calloutIndices = callouts
    .map((callout) => points.findIndex((point) => point.date === callout.date))
    .filter((index) => index >= 0);
  const kept = keepIndices(points.length, calloutIndices);
  const keptPoints = kept.map((index) => points[index]);
  const dates = points.map((point) => point.date);
  const lows = keptPoints.map((point) => point.p10);
  const medians = keptPoints.map((point) => point.median);
  const highs = keptPoints.map((point) => point.p90);
  const domain = yDomain([lows, highs]);
  const scaleX = makeScaleX(kept.length, PAD.left, W - PAD.left - PAD.right);
  const scaleY = makeScaleY(domain, PAD.top, H - PAD.top - PAD.bottom);
  const ticks = [domain.lo, (domain.lo + domain.hi) / 2, domain.hi];
  const monthTicks = monthTickPositions(dates, kept);
  const plottedCallouts = callouts.flatMap((callout) => {
    const original = points.findIndex((point) => point.date === callout.date);
    const position = kept.indexOf(original);
    return position < 0 ? [] : [{ callout, position }];
  });
  const label = `Projected total balance from ${twinDate(points[0].date, asOf)} through ${twinDate(points.at(-1)!.date, asOf)}. The line is the median and the shaded band spans the 10th to 90th percentile.`;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label}>
        <title>{label}</title>
        {ticks.map((value) => (
          <g key={value} aria-hidden="true">
            <line x1={PAD.left} x2={W - PAD.right} y1={scaleY(value)} y2={scaleY(value)} className="stroke-line" />
            <text x={PAD.left - 8} y={scaleY(value) + 3} textAnchor="end" className="tnum fill-faint text-[10px]">{money(value)}</text>
          </g>
        ))}
        <path d={buildBandPath(highs, lows, scaleX, scaleY)} className="fill-baseline/15" aria-hidden="true" />
        <path d={buildPath(medians, scaleX, scaleY)} fill="none" className="stroke-baseline" strokeWidth={2.5} aria-hidden="true" />
        {monthTicks.map((position) => (
          <text key={keptPoints[position].date} x={scaleX(position)} y={H - 8} textAnchor="middle" className="fill-faint text-[10px]" aria-hidden="true">
            {twinDate(keptPoints[position].date, asOf)}
          </text>
        ))}
        {plottedCallouts.map(({ callout, position }) => {
          const selected = active === callout.date;
          return (
            <g key={`${callout.kind}-${callout.date}`}>
              {selected ? <text x={Math.min(Math.max(scaleX(position), 110), W - 110)} y={Math.max(16, scaleY(callout.balance) - 13)} textAnchor="middle" className="fill-ink text-[11px] font-medium" aria-hidden="true">{callout.label}</text> : null}
              <circle
                cx={scaleX(position)} cy={scaleY(callout.balance)} r={selected ? 7 : 5}
                tabIndex={0} role="button" aria-label={`${callout.label}, ${money(callout.balance)}`}
                className="cursor-pointer fill-counter stroke-surface outline-none focus:stroke-ink" strokeWidth={selected ? 3 : 2}
                onPointerEnter={() => setActive(callout.date)} onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(callout.date)} onBlur={() => setActive(null)}
                onClick={() => setActive((current) => current === callout.date ? null : callout.date)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActive((current) => current === callout.date ? null : callout.date);
                  }
                }}
              />
            </g>
          );
        })}
      </svg>
      <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2" aria-label="Forecast callouts">
        {callouts.length ? callouts.map((callout) => (
          <li key={`${callout.kind}-${callout.date}`} className="rounded-lg border border-line px-3 py-2">
            <span className="font-medium text-ink">{callout.label}</span>
            <span className="ml-2 tnum text-muted">{money(callout.balance)}</span>
            <span className="sr-only"><DateText date={callout.date} asOf={asOf} /></span>
          </li>
        )) : <li className="text-muted">No notable highs or lows in this projection.</li>}
      </ul>
    </div>
  );
}
