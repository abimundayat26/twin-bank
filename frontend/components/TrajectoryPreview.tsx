"use client";

/**
 * The Simulator's collapsed look at the balance over time (SM-8 to SM-10).
 *
 * Closed by default: the comparison above answers the question, and the shape
 * of the next 90 days is the follow-up. Opened, it plots exactly what
 * `balance_bands` holds, cut to a window — the frontend slices a series to a
 * display window and does nothing else to it (SM-9, G-6). No skew, no
 * smoothing, no widening of the fan.
 *
 * The metrics above always describe the full horizon, so the 90-day view says
 * so rather than letting the reader read the chart's end as the answer.
 */

import { useState } from "react";
import { BalanceTrajectoryChart, type ChartMarker } from "./BalanceTrajectoryChart";
import { addDays } from "@/lib/dates";
import { twinDate } from "@/lib/format";
import type { BalanceBandPoint, BalanceBands, ScenarioBands } from "@/lib/types";
import { Card } from "./ui";

/** A5: the preview window. */
export const PREVIEW_DAYS = 90;

type Window = "preview" | "full";

const cut = (points: BalanceBandPoint[] | undefined, lastDate: string): BalanceBandPoint[] =>
  (points ?? []).filter((point) => point.date <= lastDate);

const cutScenario = (bands: ScenarioBands, lastDate: string): ScenarioBands => ({
  total: cut(bands.total, lastDate),
  checking: cut(bands.checking, lastDate),
});

/** Keeps every point up to and including `lastDate`. Nothing is resampled. */
export function cutBands(bands: BalanceBands, lastDate: string): BalanceBands {
  return {
    baseline: cutScenario(bands.baseline, lastDate),
    counterfactual: cutScenario(bands.counterfactual, lastDate),
  };
}

export function TrajectoryPreview({
  bands,
  asOf,
  horizonEnd,
  reserve,
  simulations,
  markers = [],
}: {
  bands?: BalanceBands | null;
  asOf: string;
  horizonEnd: string;
  reserve?: number;
  simulations?: number | null;
  markers?: ChartMarker[];
}) {
  const [window, setWindow] = useState<Window>("preview");

  // E-5: a result without bands says so, and shows no chart drawn from nothing.
  if (!bands) {
    return (
      <Card title={`Balance over the next ${PREVIEW_DAYS} days`}>
        <p className="text-sm text-muted">No projection available for this result.</p>
      </Card>
    );
  }

  const lastPreviewDate = addDays(asOf, PREVIEW_DAYS);
  const shown = window === "preview" ? cutBands(bands, lastPreviewDate) : bands;

  return (
    <details className="rounded-xl border border-line bg-surface">
      <summary className="cursor-pointer list-none px-5 py-4 text-sm font-semibold uppercase tracking-wider text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter">
        Balance over the next {PREVIEW_DAYS} days
      </summary>

      <div className="px-5 pb-5">
        <div
          className="mb-3 flex items-center gap-1"
          role="group"
          aria-label="How much of the projection to show"
        >
          {(
            [
              ["preview", `${PREVIEW_DAYS} days`],
              ["full", "Full horizon"],
            ] as const
          ).map(([option, optionLabel]) => (
            <button
              key={option}
              type="button"
              aria-pressed={window === option}
              onClick={() => setWindow(option)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
                window === option
                  ? "border-baseline bg-raised text-baseline"
                  : "border-line text-muted hover:text-ink"
              }`}
            >
              {optionLabel}
            </button>
          ))}
        </div>

        <BalanceTrajectoryChart
          bands={shown}
          reserve={reserve}
          simulations={simulations}
          markers={markers}
        />

        {window === "preview" ? (
          <p className="mt-3 text-xs text-faint">
            Chart shows {PREVIEW_DAYS} days. Figures above cover through{" "}
            {twinDate(horizonEnd, asOf)}.
          </p>
        ) : null}
      </div>
    </details>
  );
}
