/**
 * Baseline vs counterfactual, side by side.
 *
 * Every number here comes straight from `ScenarioMetrics`. The only arithmetic
 * is the counterfactual-minus-baseline delta shown next to a value, which is a
 * presentation of two figures the backend already produced — no simulation,
 * no thresholds, no invented risk values.
 */

import { chance, money, moneyExact, longDate, signedMoney } from "@/lib/format";
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

/** Percentage-point change, e.g. "+59 pts". */
function pointsDelta(baseline: number, counterfactual: number): string {
  const points = Math.round((counterfactual - baseline) * 100);
  return `${points > 0 ? "+" : ""}${points} pts`;
}

function buildRows(
  simulations: number | null | undefined,
  horizonEnd: string,
  reserve?: FinancialConstraint,
  goal?: Goal,
): MetricRow[] {
  // ISO dates compare correctly as strings.
  const goalAfterHorizon = goal != null && goal.deadline > horizonEnd;
  // Monte Carlo results report balances as medians; mock results omit the count.
  return [
    {
      label: simulations ? "Median ending balance" : "Ending balance",
      caption: simulations
        ? `At the end of the horizon, across ${simulations.toLocaleString("en-US")} simulated futures`
        : "At the end of the horizon",
      render: (m) => moneyExact(m.ending_balance),
      delta: (b, c) => signedMoney(c.ending_balance - b.ending_balance),
      worse: (b, c) => c.ending_balance < b.ending_balance,
    },
    {
      label: simulations ? "Median lowest balance along the way" : "Lowest balance along the way",
      caption: reserve ? `Emergency reserve is ${money(reserve.amount)}` : undefined,
      render: (m) => moneyExact(m.min_balance),
      delta: (b, c) => signedMoney(c.min_balance - b.min_balance),
      worse: (b, c) => c.min_balance < b.min_balance,
    },
    {
      label: "Chance of a low balance",
      render: (m) => chance(m.prob_low_balance),
      delta: (b, c) => pointsDelta(b.prob_low_balance, c.prob_low_balance),
      worse: (b, c) => c.prob_low_balance > b.prob_low_balance,
    },
    {
      label: "Chance of dipping into the emergency reserve",
      caption: reserve?.description,
      render: (m) => chance(m.prob_below_reserve),
      delta: (b, c) => pointsDelta(b.prob_below_reserve, c.prob_below_reserve),
      worse: (b, c) => c.prob_below_reserve > b.prob_below_reserve,
    },
    {
      label: goal ? `${goal.name} goal` : "Savings goal",
      caption: goal ? `${money(goal.target_amount)} by ${longDate(goal.deadline)}` : undefined,
      render: (m) =>
        m.prob_goal_met != null
          ? `Met in ${chance(m.prob_goal_met)} of futures`
          : goalAfterHorizon
            ? "Not evaluated (deadline after horizon)"
            : m.goal_shortfall === 0
              ? "On track"
              : `${money(m.goal_shortfall)} short`,
      delta: (b, c) =>
        b.prob_goal_met != null && c.prob_goal_met != null
          ? pointsDelta(b.prob_goal_met, c.prob_goal_met)
          : null,
      worse: (b, c) =>
        b.prob_goal_met != null && c.prob_goal_met != null
          ? c.prob_goal_met < b.prob_goal_met
          : c.goal_shortfall > b.goal_shortfall,
    },
    {
      label: "Upcoming obligations covered",
      caption: "Every mandatory bill in the horizon",
      render: (m) => {
        const missed = m.prob_obligations_uncovered;
        const status = m.obligations_covered ? "Yes" : "No";
        if (missed == null) return status;
        return missed === 0
          ? `${status} · covered in every future`
          : `${status} · covered in ${chance(1 - missed)} of futures`;
      },
      worse: (b, c) =>
        b.prob_obligations_uncovered != null && c.prob_obligations_uncovered != null
          ? c.prob_obligations_uncovered > b.prob_obligations_uncovered
          : b.obligations_covered && !c.obligations_covered,
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
  const rows = buildRows(simulation.num_simulations, simulation.horizon_end, reserve, goal);

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
