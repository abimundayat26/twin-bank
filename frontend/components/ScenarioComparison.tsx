/**
 * No Purchase against Purchase, side by side (SM-4).
 *
 * Every figure comes straight from `ScenarioMetrics`; the mapping from row to
 * field is fixed in SPEC section 7.1 so no page invents its own. Nothing here
 * computes a probability, a balance or a score (G-6) — the one comparison it
 * makes is whether the goal's chance fell far enough to bold, and that reads
 * the unrounded values the backend sent (G-4).
 *
 * A metric the backend did not compute shows "-" rather than a zero: a missing
 * probability is not the same as no risk (E-5).
 */

import type { ReactNode } from "react";
import { chance, money, twinDate } from "@/lib/format";
import type { FinancialTwin, ScenarioMetrics, SimulationResponse } from "@/lib/types";
import { ImpactBadge } from "./ImpactBadge";
import { Badge, Card } from "./ui";

/** 7.1: a probability is bold once it is at least even odds. */
const LIKELY = 0.5;

/** 7.1, Goals row: bold when the purchase costs the goal this much or more. */
const GOAL_DROP = 0.25;

interface Row {
  id: string;
  label: string;
  cell: (metrics: ScenarioMetrics) => ReactNode;
  /** Bold applies to one column at a time, so it takes the column's own metrics. */
  bold?: (metrics: ScenarioMetrics) => boolean;
  note?: (metrics: ScenarioMetrics) => string | null;
}

/** G-3, with "-" for a figure this result does not carry. */
function probability(value: number | null | undefined): string {
  return value == null ? "-" : chance(value);
}

/**
 * The Upcoming bills badge (7.2).
 *
 * `prob_obligations_uncovered` wins whenever it exists: `obligations_covered`
 * describes the single expected-value path and can disagree with the Monte
 * Carlo figure (at $2,500 for Alex it says covered while 37% of futures are
 * not).
 */
export function billsBadge(metrics: ScenarioMetrics): { text: string; tone: "good" | "caution" | "bad"; title?: string } {
  const p = metrics.prob_obligations_uncovered;
  if (p == null) {
    return metrics.obligations_covered
      ? { text: "Covered", tone: "good" }
      : { text: "Not covered", tone: "bad" };
  }
  const title = `A bill goes uncovered in ${chance(p)} of futures`;
  if (p === 0) return { text: "Covered", tone: "good", title };
  if (p < LIKELY) return { text: "At risk", tone: "caution", title };
  return { text: "Not covered", tone: "bad", title };
}

function buildRows(twin: FinancialTwin, baseline: ScenarioMetrics): Row[] {
  const hasReserve = twin.constraints.some((c) => c.type === "minimum_reserve");
  const showGoals = twin.goals.length > 0 && baseline.prob_goal_met != null;

  const rows: Row[] = [
    {
      id: "balance",
      label: "Predicted balance",
      cell: (m) => money(m.ending_balance),
    },
    {
      id: "low-balance",
      label: "Chance of low balance",
      cell: (m) => probability(m.prob_low_balance),
      bold: (m) => m.prob_low_balance >= LIKELY,
    },
  ];

  // E-4: a twin that has declared no reserve has no reserve to dip into.
  if (hasReserve) {
    rows.push({
      id: "reserve",
      label: "Chance of dipping into your reserve",
      cell: (m) => probability(m.prob_below_reserve),
      bold: (m) => m.prob_below_reserve >= LIKELY,
    });
  }

  rows.push({
    id: "sweep",
    label: "Chance of paying a bill out of savings",
    cell: (m) => probability(m.prob_savings_sweep),
    bold: (m) => m.prob_savings_sweep != null && m.prob_savings_sweep >= LIKELY,
  });

  if (showGoals) {
    rows.push({
      id: "goals",
      label: twin.goals.length > 1 ? "Chance every goal is met" : "Chance your goal is met",
      cell: (m) => probability(m.prob_goal_met),
      bold: (m) =>
        baseline.prob_goal_met != null &&
        m.prob_goal_met != null &&
        baseline.prob_goal_met - m.prob_goal_met >= GOAL_DROP,
      note: (m) => (m.goal_shortfall > 0 ? `Short by ${money(m.goal_shortfall)}` : null),
    });
  }

  rows.push({
    id: "bills",
    label: "Upcoming bills",
    cell: (m) => {
      const badge = billsBadge(m);
      return (
        <span title={badge.title}>
          <Badge tone={badge.tone}>{badge.text}</Badge>
        </span>
      );
    },
  });

  return rows;
}

function Cell({ row, metrics }: { row: Row; metrics: ScenarioMetrics }) {
  const note = row.note?.(metrics) ?? null;
  return (
    <div className="bg-raised px-3 py-3 sm:px-4">
      <span
        className={`tnum text-sm text-ink ${row.bold?.(metrics) ? "font-bold" : "font-medium"}`}
      >
        {row.cell(metrics)}
      </span>
      {note ? <p className="tnum mt-0.5 text-xs text-caution">{note}</p> : null}
    </div>
  );
}

export function ScenarioComparison({
  twin,
  simulation,
  planChanged,
}: {
  twin: FinancialTwin;
  simulation: SimulationResponse;
  planChanged: boolean;
}) {
  const { baseline, counterfactual, impact } = simulation;
  const purchase = simulation.request.events[0];
  const rows = buildRows(twin, baseline);

  return (
    <Card>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Two futures
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {/* G-13: the numbers are a saved example, and the page says so. */}
          {simulation.is_mock ? <Badge tone="neutral">Sample figures</Badge> : null}
          {impact ? <ImpactBadge impact={impact} /> : null}
        </div>
      </header>

      {planChanged ? (
        <p role="status" className="mb-4 rounded-lg border border-caution/40 bg-caution/10 px-3 py-2 text-sm text-caution">
          Out of date: your plan changed. Simulate again.
        </p>
      ) : null}

      {/* Two columns at every width (SM-4, E-21); the label moves above them
          below the `sm` breakpoint instead of squeezing a third column in. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-[1.4fr_1fr_1fr]">
        <div className="col-span-2 bg-surface px-3 py-3 sm:col-span-1 sm:px-4">
          <p className="text-xs text-faint" title={simulation.horizon_end}>
            Through {twinDate(simulation.horizon_end, twin.as_of)}
          </p>
        </div>
        <div className="bg-surface px-3 py-3 text-center sm:px-4 sm:text-left">
          <p className="text-xs font-semibold uppercase tracking-wider text-baseline">
            No Purchase
          </p>
        </div>
        <div className="bg-surface px-3 py-3 text-center sm:px-4 sm:text-left">
          <p className="text-xs font-semibold uppercase tracking-wider text-counter">Purchase</p>
          {/* G-2, and it wraps: this column is the narrowest, and a long
              purchase name has to stay readable rather than overlap (G-20). */}
          {purchase ? (
            <p className="break-words text-xs text-faint">
              {purchase.description} · {money(purchase.amount)}
            </p>
          ) : null}
        </div>

        {rows.map((row) => (
          <div key={row.id} className="contents">
            <div className="col-span-2 bg-raised px-3 pt-3 text-xs text-muted sm:col-span-1 sm:px-4 sm:py-3 sm:text-sm sm:text-ink">
              {row.label}
            </div>
            <Cell row={row} metrics={baseline} />
            <Cell row={row} metrics={counterfactual} />
          </div>
        ))}
      </div>
    </Card>
  );
}
