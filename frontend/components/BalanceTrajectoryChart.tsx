"use client";

/**
 * Baseline vs counterfactual balance over the simulated horizon, as a fan chart.
 *
 * Every plotted value comes from `SimulationResponse.balance_bands`, which the
 * backend's Monte Carlo produced; the only arithmetic here is dollars-to-pixels
 * (see `lib/chart.ts`). The solid lines are the daily median across runs, which
 * is the same statistic `ScenarioComparison` labels "median ending balance". The
 * shaded fans are the daily 10th-to-90th percentile.
 *
 * The two scenarios share their random draws in every run (common random
 * numbers, see `simulation/monte_carlo.py`), so the gap between the two medians
 * is the purchase and not sampling noise.
 *
 * Deliberately NOT annotated: the lowest balance. The engine measures its trough
 * mid-day (after outflows, before inflows) but records these bands end-of-day, so
 * `min_balance` is not a point on these lines — for checking the true low lands on
 * a day a paycheck arrives, where the line sits hundreds of dollars higher. A
 * "lowest balance" marker drawn from this data would contradict the comparison
 * table directly below it. The reserve, the purchase date and goal deadlines are
 * exact, so those are the only marks.
 */

import { useState } from "react";
import {
  alignedLength,
  areIdentical,
  buildBandPath,
  buildPath,
  extremeIndices,
  keepIndices,
  makeScaleX,
  makeScaleY,
  monthTickPositions,
  positionOfDate,
  toTrack,
  yDomain,
} from "@/lib/chart";
import { longDate, money, moneyExact, shortDate, signedMoney } from "@/lib/format";
import type { BalanceBands, IsoDate } from "@/lib/types";
import { Card } from "./ui";

const W = 720;
const H = 260;
const PAD = { top: 14, right: 16, bottom: 26, left: 56 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

type Metric = "total" | "checking";

export interface ChartMarker {
  date: IsoDate;
  label: string;
  tone: "counter" | "faint";
}

export function BalanceTrajectoryChart({
  bands,
  reserve,
  checkingMinimum,
  checkingMinimumIsDefault = false,
  simulations,
  markers = [],
  counterfactualLabel = "With the purchase",
}: {
  bands?: BalanceBands | null;
  reserve?: number;
  /** The threshold behind `prob_low_balance`, drawn on the checking view. */
  checkingMinimum?: number;
  /** Distinguishes the simulator's fallback from a limit the user declared. */
  checkingMinimumIsDefault?: boolean;
  /** `num_simulations`, so the fan can say how many futures it summarises. */
  simulations?: number | null;
  markers?: ChartMarker[];
  counterfactualLabel?: string;
}) {
  const [metric, setMetric] = useState<Metric>("total");
  const [hover, setHover] = useState<number | null>(null);

  const baselinePoints = bands?.baseline?.[metric];
  const counterfactualPoints = bands?.counterfactual?.[metric];
  const count = alignedLength(baselinePoints, counterfactualPoints);

  // One point is not a trajectory. Degrade to a line of text rather than crash:
  // a mock result, or a backend that ran without bands, lands here.
  if (!baselinePoints || !counterfactualPoints || count < 2) {
    return (
      <Card title="Balance trajectory">
        <p className="text-sm text-muted">
          No balance trajectory in this result. The comparison below still applies.
        </p>
      </Card>
    );
  }

  const base = toTrack(baselinePoints, count);
  const counter = toTrack(counterfactualPoints, count);
  const dates = base.dates;

  const reference =
    metric === "total" && typeof reserve === "number" && reserve > 0
      ? { value: reserve, label: `Reserve ${money(reserve)}` }
      : metric === "checking" &&
          typeof checkingMinimum === "number" &&
          checkingMinimum >= 0
        ? {
            value: checkingMinimum,
            label: checkingMinimumIsDefault
              ? `Default low-balance ${money(checkingMinimum)}`
              : `Minimum ${money(checkingMinimum)}`,
          }
        : null;
  const identical = areIdentical(base.median, counter.median);

  const kept = keepIndices(count, [
    ...extremeIndices(base.p10),
    ...extremeIndices(counter.p10),
    ...extremeIndices(base.p90),
    ...extremeIndices(counter.p90),
  ]);
  const pick = (values: number[]) => kept.map((index) => values[index]);
  const baseMedian = pick(base.median);
  const counterMedian = pick(counter.median);
  const baseLo = pick(base.p10);
  const baseHi = pick(base.p90);
  const counterLo = pick(counter.p10);
  const counterHi = pick(counter.p90);
  const keptDates = kept.map((index) => dates[index]);

  const domain = yDomain(
    [baseLo, baseHi, counterLo, counterHi],
    reference ? [reference.value] : [],
  );
  const scaleX = makeScaleX(kept.length, PAD.left, PLOT_W);
  const scaleY = makeScaleY(domain, PAD.top, PLOT_H);

  const candidateTicks = [domain.lo, (domain.lo + domain.hi) / 2, domain.hi];
  // Zero earns its own line whenever the plot straddles it.
  if (domain.lo < 0 && domain.hi > 0) candidateTicks.push(0);
  // Two ticks can round to the same label, which would draw the gridline twice.
  const seenTickLabels = new Set<string>();
  const yTicks = candidateTicks.filter((value) => {
    const text = money(value);
    if (seenTickLabels.has(text)) return false;
    seenTickLabels.add(text);
    return true;
  });
  const monthTicks = monthTickPositions(dates, kept);

  const endBaseline = base.median[count - 1];
  const endCounterfactual = counter.median[count - 1];
  const runs = simulations ? `${simulations.toLocaleString("en-US")} simulated futures` : "the simulation";
  const label =
    `Projected ${metric} balance from ${longDate(dates[0])} to ` +
    `${longDate(dates[count - 1])}, as the median across ${runs}. Baseline ends at ` +
    `${money(endBaseline)}, with the purchase ${money(endCounterfactual)}, ` +
    `a difference of ${signedMoney(endCounterfactual - endBaseline)}. ` +
    `Shaded areas span the 10th to 90th percentile.` +
    (reference ? ` ${reference.label} reference line is shown.` : "");

  const hoverX = hover === null ? 0 : scaleX(hover);
  const hoverPercent = Math.min(Math.max((hoverX / W) * 100, 8), 92);

  return (
    <Card
      title="Balance trajectory"
      subtitle={`Median end-of-day projection, ${shortDate(dates[0])} through ${shortDate(
        dates[count - 1],
      )}`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="h-0.5 w-4 rounded bg-baseline" aria-hidden="true" />
            Baseline <span className="tnum text-ink">{money(endBaseline)}</span>
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <span
              className="h-0.5 w-4"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(to right, var(--color-counter) 0 4px, transparent 4px 7px)",
              }}
              aria-hidden="true"
            />
            {counterfactualLabel} <span className="tnum text-ink">{money(endCounterfactual)}</span>
          </span>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Which balance to plot">
          {(["total", "checking"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={metric === option}
              onClick={() => setMetric(option)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
                metric === option
                  ? "border-baseline bg-raised text-baseline"
                  : "border-line text-muted hover:text-ink"
              }`}
            >
              {option === "total" ? "Total" : "Checking"}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-none"
          role="img"
          aria-label={label}
        >
          <title>{label}</title>

          {yTicks.map((value) => (
            <g key={`y-${value}`} aria-hidden="true">
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={scaleY(value)}
                y2={scaleY(value)}
                className={value === 0 ? "stroke-bad/60" : "stroke-line"}
                strokeWidth={1}
                strokeDasharray={value === 0 ? "4 4" : undefined}
              />
              <text
                x={PAD.left - 8}
                y={scaleY(value) + 3}
                textAnchor="end"
                className="tnum fill-faint text-[10px]"
              >
                {money(value)}
              </text>
            </g>
          ))}

          {monthTicks.map((position) => (
            <text
              key={`x-${position}`}
              x={scaleX(position)}
              y={H - 8}
              textAnchor="middle"
              className="fill-faint text-[10px]"
              aria-hidden="true"
            >
              {shortDate(keptDates[position])}
            </text>
          ))}

          {/* The fans: where the balance lands in 80% of simulated futures. The
              baseline's sits underneath so the counterfactual stays readable. */}
          {!identical ? (
            <path
              d={buildBandPath(baseHi, baseLo, scaleX, scaleY)}
              className="fill-baseline/15"
              aria-hidden="true"
            />
          ) : null}
          <path
            d={buildBandPath(counterHi, counterLo, scaleX, scaleY)}
            className="fill-counter/20"
            aria-hidden="true"
          />

          {reference ? (
            <g aria-hidden="true">
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={scaleY(reference.value)}
                y2={scaleY(reference.value)}
                className="stroke-caution"
                strokeWidth={1}
                strokeDasharray="5 4"
              />
              <text
                x={W - PAD.right}
                y={scaleY(reference.value) - 5}
                textAnchor="end"
                className="tnum fill-caution text-[10px]"
              >
                {reference.label}
              </text>
            </g>
          ) : null}

          {markers.map((marker) => {
            const position = positionOfDate(dates, kept, marker.date);
            if (position < 0) return null;
            const x = scaleX(position);
            const nearRightEdge = x > W - PAD.right - 90;
            return (
              <g key={`${marker.label}-${marker.date}`} aria-hidden="true">
                <line
                  x1={x}
                  x2={x}
                  y1={PAD.top}
                  y2={PAD.top + PLOT_H}
                  className={marker.tone === "counter" ? "stroke-counter/70" : "stroke-faint/70"}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                <text
                  x={nearRightEdge ? x - 4 : x + 4}
                  y={PAD.top + 9}
                  textAnchor={nearRightEdge ? "end" : "start"}
                  className={`text-[10px] ${
                    marker.tone === "counter" ? "fill-counter" : "fill-faint"
                  }`}
                >
                  {marker.label}
                </text>
              </g>
            );
          })}

          {/* Baseline first so the counterfactual is never occluded. When the two
              coincide exactly, drawing both would hide the purchase line entirely. */}
          {!identical ? (
            <path
              d={buildPath(baseMedian, scaleX, scaleY)}
              className="stroke-baseline"
              fill="none"
              strokeWidth={1.75}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          <path
            d={buildPath(counterMedian, scaleX, scaleY)}
            className="stroke-counter"
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            /* Dashed, not merely red: blue and red share a luminance, so the line
               style is what separates the two projections (SPEC §6, §11). */
            strokeDasharray="7 4"
            vectorEffect="non-scaling-stroke"
          />

          {hover !== null ? (
            <g aria-hidden="true">
              <line
                x1={hoverX}
                x2={hoverX}
                y1={PAD.top}
                y2={PAD.top + PLOT_H}
                className="stroke-line"
                strokeWidth={1}
              />
              {!identical ? (
                <circle
                  cx={hoverX}
                  cy={scaleY(baseMedian[hover])}
                  r={3}
                  className="fill-baseline"
                />
              ) : null}
              <circle cx={hoverX} cy={scaleY(counterMedian[hover])} r={3} className="fill-counter" />
            </g>
          ) : null}

          {/* One hit target for the whole plot, not one per day. */}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={PLOT_W}
            height={PLOT_H}
            fill="transparent"
            onPointerMove={(pointer) => {
              const box = pointer.currentTarget.getBoundingClientRect();
              if (!box.width) return;
              const fraction = (pointer.clientX - box.left) / box.width;
              const position = Math.round(fraction * (kept.length - 1));
              setHover(Math.min(kept.length - 1, Math.max(0, position)));
            }}
            onPointerLeave={() => setHover(null)}
          />
        </svg>

        {hover !== null ? (
          <div
            className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs shadow-sm"
            style={{ left: `${hoverPercent}%` }}
          >
            <p className="text-faint">{longDate(keptDates[hover])}</p>
            <p className="tnum text-baseline">{moneyExact(baseMedian[hover])}</p>
            <p className="tnum text-counter">{moneyExact(counterMedian[hover])}</p>
            {!identical ? (
              <p className="tnum text-muted">
                {signedMoney(counterMedian[hover] - baseMedian[hover])}
              </p>
            ) : null}
            <p className="tnum mt-1 border-t border-line pt-1 text-faint">
              {money(counterLo[hover])} to {money(counterHi[hover])}
            </p>
          </div>
        ) : null}
      </div>

      <p className="mt-3 text-xs text-muted">
        {identical ? (
          <>
            This purchase does not change the projected median {metric} balance on any day in the
            horizon, so the two paths coincide.{" "}
          </>
        ) : null}
        Lines are the median across {runs}; shaded areas cover the 10th to 90th percentile. The
        lowest balance in the comparison below is measured mid-day and will sit under these
        end-of-day lines.
      </p>
    </Card>
  );
}
