/**
 * Up to three other ways to make the same purchase (SM-11).
 *
 * The rows are chosen by `lib/alternatives`, deterministically, and every
 * figure in them comes from the backend. The "Buy as planned" row shows the
 * Purchase column's own numbers rather than the `buy_now` candidate's, so the
 * screen never carries two different answers to one question.
 */

import { alternativeRows, type AlternativeRow } from "@/lib/alternatives";
import { chance, money } from "@/lib/format";
import type { OptimizationResponse, ScenarioMetrics } from "@/lib/types";
import { Badge, Card } from "./ui";

const COLUMNS = ["Option", "Predicted balance", "Chance of low balance", "Chance goal is met"];

function goalCell(metrics: ScenarioMetrics): string {
  return metrics.prob_goal_met == null ? "-" : chance(metrics.prob_goal_met);
}

function LimitsCell({ row }: { row: AlternativeRow }) {
  if (row.candidate.meets_constraints) return <Badge tone="good">Yes</Badge>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone="caution">No</Badge>
      {/* The first one only: the point is that a limit breaks, and the rest
          would push the table past a phone's width (G-20). */}
      {row.violations[0] ? (
        <span className="break-words text-xs text-muted">{row.violations[0]}</span>
      ) : null}
    </div>
  );
}

export function AlternativesPanel({
  optimization,
  purchaseMetrics,
}: {
  optimization: OptimizationResponse;
  /** The counterfactual from `/simulate`; see `alternativeRows`. */
  purchaseMetrics?: ScenarioMetrics;
}) {
  const rows = alternativeRows(optimization, purchaseMetrics);

  if (rows.length === 0) {
    return (
      <Card title="Other ways to do this">
        {/* G-8: the optimizer ran and found nothing, which is not an error. */}
        <p className="text-sm text-muted">No other way to make this purchase was found.</p>
      </Card>
    );
  }

  return (
    <Card title="Other ways to do this">
      <div className="overflow-hidden rounded-lg border border-line">
        {/* Stacked rows below 640px rather than a table that scrolls (G-20). */}
        <table className="w-full border-collapse text-left text-sm">
          <thead className="sr-only sm:not-sr-only">
            <tr className="bg-surface">
              {[...COLUMNS, "Keeps your limits"].map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-faint"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className="flex flex-col gap-1 border-t border-line bg-raised px-3 py-3 sm:table-row sm:gap-0 sm:px-0 sm:py-0"
              >
                <th scope="row" className="px-0 py-0 text-left font-normal sm:px-3 sm:py-3">
                  <span className="block text-sm font-medium text-ink">{row.label}</span>
                  <span className="block break-words text-xs text-muted">{row.detail}</span>
                </th>
                <td className="tnum px-0 py-0 text-sm text-ink sm:px-3 sm:py-3">
                  <span className="text-xs text-faint sm:hidden">Predicted balance: </span>
                  {money(row.metrics.ending_balance)}
                </td>
                <td className="tnum px-0 py-0 text-sm text-ink sm:px-3 sm:py-3">
                  <span className="text-xs text-faint sm:hidden">Chance of low balance: </span>
                  {chance(row.metrics.prob_low_balance)}
                </td>
                <td className="tnum px-0 py-0 text-sm text-ink sm:px-3 sm:py-3">
                  <span className="text-xs text-faint sm:hidden">Chance goal is met: </span>
                  {goalCell(row.metrics)}
                </td>
                <td className="px-0 py-0 sm:px-3 sm:py-3">
                  <LimitsCell row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
