/**
 * Which of the optimizer's candidates the Simulator shows (SM-11).
 *
 * At most three rows, chosen by fixed rules rather than by judgement, so the
 * same optimization always produces the same table. This picks and labels; it
 * computes no figure of its own (G-6).
 */

import type {
  OptimizationCandidate,
  OptimizationResponse,
  ScenarioMetrics,
} from "./types";

export type RowKey = "buy_now" | "best" | "compromise";

export interface AlternativeRow {
  key: RowKey;
  label: string;
  detail: string;
  candidate: OptimizationCandidate;
  /** What the row displays. Not always the candidate's own metrics — see below. */
  metrics: ScenarioMetrics;
  /** Declared limits this option breaks, in the backend's words. */
  violations: string[];
}

/**
 * The three rows, in order, with any repeat dropped.
 *
 * `purchaseMetrics` is the counterfactual from `/simulate`. It is what the
 * "Buy as planned" row shows, **not** the `buy_now` candidate's own metrics:
 * `/simulate` and `/optimize` each run their own Monte Carlo, and unseeded the
 * two can differ by a few points. The Purchase column is authoritative, so one
 * screen never shows two different numbers for the same thing (9.4's
 * consistency rule).
 */
export function alternativeRows(
  optimization: OptimizationResponse,
  purchaseMetrics?: ScenarioMetrics,
): AlternativeRow[] {
  const { candidates, recommended_id } = optimization;
  const rows: AlternativeRow[] = [];
  const used = new Set<string>();

  const add = (key: RowKey, label: string, candidate?: OptimizationCandidate) => {
    if (!candidate || used.has(candidate.id)) return;
    used.add(candidate.id);
    rows.push({
      key,
      label,
      detail: candidate.detail,
      candidate,
      metrics:
        key === "buy_now" && purchaseMetrics ? purchaseMetrics : candidate.metrics,
      violations: candidate.violations,
    });
  };

  const buyNow = candidates.find((c) => c.kind === "buy_now");
  add("buy_now", "Buy as planned", buyNow);

  // No candidate keeps every limit, so the best available is named for what it
  // is rather than recommended (G-9's honesty applied to a ranking).
  const best = recommended_id
    ? candidates.find((c) => c.id === recommended_id)
    : candidates.find((c) => !used.has(c.id));
  add("best", recommended_id ? "Best alternative" : "Closest to your limits", best);

  // A different lever, not a slightly different version of the same one.
  const spent = new Set([buyNow?.kind, best?.kind]);
  add(
    "compromise",
    "Compromise",
    candidates.find((c) => !used.has(c.id) && !spent.has(c.kind)),
  );

  return rows;
}

/**
 * The row whose events Apply Compromise would commit, or null.
 *
 * SM-12: a spending cut cannot be saved — nothing in the twin records "spend
 * 50% less on eating out" — so a compromise that depends on one is shown and
 * left un-applyable rather than pretended into the plan.
 */
export function compromiseIsApplyable(row: AlternativeRow | undefined): boolean {
  return row != null && row.candidate.spending_adjustments.length === 0;
}
