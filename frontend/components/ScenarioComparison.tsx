/**
 * Baseline vs counterfactual, side by side.
 *
 * Every number here comes straight from `ScenarioMetrics`. The only arithmetic
 * is the counterfactual-minus-baseline delta shown next to a value, which is a
 * presentation of two figures the backend already produced — no simulation,
 * no thresholds, no invented risk values.
 */

import { money, moneyExact, percent, longDate, signedMoney } from "@/lib/format";
import type {
  FinancialConstraint,
  Goal,
  ScenarioMetrics,
  SimulationResponse,
} from "@/lib/types";
import { Badge, Card } from "./ui";

type Tone = "good" | "caution" | "neutral";

interface MetricRow {
  label: string;
  caption?: string;
  /** Rendered value per scenario. */
  render: (metrics: ScenarioMetrics) => string;
  /** Delta text for the counterfactual column, if the metric has one. */
  delta?: (baseline: ScenarioMetrics, counterfactual: ScenarioMetrics) => string | null;
  /** Is the counterfactual worse than the baseline on this metric? */
  worse: (baseline: ScenarioMetrics, counterfactual: ScenarioMetrics) => boolean;
}

function buildRows(reserve?: FinancialConstraint, goal?: Goal): MetricRow[] {
  return [
    {
      label: "Ending balance",
      caption: "At the end of the horizon",
      render: (m) => moneyExact(m.ending_balance),
      delta: (b, c) => signedMoney(c.ending_balance - b.ending_balance),
      worse: (b, c) => c.ending_balance < b.ending_balance,
    },
    {
      label: "Lowest balance along the way",
      caption: reserve ? `Emergency reserve is ${money(reserve.amount)}` : undefined,
      render: (m) => moneyExact(m.min_balance),
      delta: (b, c) => signedMoney(c.min_balance - b.min_balance),
      worse: (b, c) => c.min_balance < b.min_balance,
    },
    {
      label: "Chance of a low balance",
      render: (m) => percent(m.prob_low_balance),
      delta: (b, c) =>
        `${c.prob_low_balance > b.prob_low_balance ? "+" : ""}${Math.round(
          (c.prob_low_balance - b.prob_low_balance) * 100,
        )} pts`,
      worse: (b, c) => c.prob_low_balance > b.prob_low_balance,
    },
    {
      label: "Chance of dipping into the emergency reserve",
      caption: reserve?.description,
      render: (m) => percent(m.prob_below_reserve),
      delta: (b, c) =>
        `${c.prob_below_reserve > b.prob_below_reserve ? "+" : ""}${Math.round(
          (c.prob_below_reserve - b.prob_below_reserve) * 100,
        )} pts`,
      worse: (b, c) => c.prob_below_reserve > b.prob_below_reserve,
    },
    {
      label: goal ? `${goal.name} goal` : "Savings goal",
      caption: goal ? `${money(goal.target_amount)} by ${longDate(goal.deadline)}` : undefined,
      render: (m) => (m.goal_shortfall === 0 ? "On track" : `${money(m.goal_shortfall)} short`),
      worse: (b, c) => c.goal_shortfall > b.goal_shortfall,
    },
    {
      label: "Upcoming obligations covered",
      caption: "Every mandatory bill in the horizon",
      render: (m) => (m.obligations_covered ? "Yes" : "No"),
      worse: (b, c) => b.obligations_covered && !c.obligations_covered,
    },
  ];
}

function Value({ text, tone = "neutral" }: { text: string; tone?: Tone }) {
  const tones = { good: "text-ink", caution: "text-caution", neutral: "text-ink" } as const;
  return <span className={`tnum text-base font-medium ${tones[tone]}`}>{text}</span>;
}

export function ScenarioComparison({
  simulation,
  reserve,
  goal,
}: {
  simulation: SimulationResponse;
  reserve?: FinancialConstraint;
  goal?: Goal;
}) {
  const { baseline, counterfactual } = simulation;
  const purchase = simulation.request.events[0];
  const rows = buildRows(reserve, goal);

  return (
    <Card
      title="Baseline vs. this purchase"
      subtitle={`Horizon: today through ${longDate(simulation.horizon_end)}`}
    >
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-[1.4fr_1fr_1fr]">
        <div className="bg-surface px-4 py-3 text-xs font-semibold uppercase tracking-wider text-faint">
          Metric
        </div>
        <div className="bg-surface px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-baseline">
            Baseline
          </p>
          <p className="text-xs text-faint">No purchase</p>
        </div>
        <div className="bg-surface px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-counter">
            Counterfactual
          </p>
          <p className="truncate text-xs text-faint">
            {purchase.description} · {money(purchase.amount)}
          </p>
        </div>

        {rows.map((row) => {
          const isWorse = row.worse(baseline, counterfactual);
          const delta = row.delta?.(baseline, counterfactual) ?? null;
          return (
            <div key={row.label} className="contents">
              <div className="bg-raised px-4 py-4">
                <p className="text-sm text-ink">{row.label}</p>
                {row.caption ? (
                  <p className="mt-0.5 text-xs text-faint">{row.caption}</p>
                ) : null}
              </div>
              <div className="flex items-center bg-raised px-4 py-4">
                <Value text={row.render(baseline)} />
              </div>
              <div className="flex flex-wrap items-center gap-2 bg-raised px-4 py-4">
                <Value text={row.render(counterfactual)} tone={isWorse ? "caution" : "neutral"} />
                {delta ? (
                  <span className={`tnum text-xs ${isWorse ? "text-caution" : "text-muted"}`}>
                    {delta}
                  </span>
                ) : null}
                {!delta && isWorse ? <Badge tone="caution">Worse</Badge> : null}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
