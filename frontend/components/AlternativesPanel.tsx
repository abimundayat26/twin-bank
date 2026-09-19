/**
 * Other ways to make the same purchase, from `POST /optimize`.
 *
 * Every number comes straight from each candidate's `ScenarioMetrics`. The
 * backend ranks the options; this panel keeps that order but never calls one
 * "recommended" or "best" (SPEC section 3): it shows each option's tradeoffs
 * next to the future without the purchase, and Alex decides.
 */

import { chance, money, moneyExact } from "@/lib/format";
import type {
  FinancialConstraint,
  Goal,
  OptimizationCandidate,
  OptimizationResponse,
  ScenarioMetrics,
} from "@/lib/types";
import { Badge, Card } from "./ui";

interface Stat {
  label: string;
  render: (metrics: ScenarioMetrics) => string;
}

function buildStats(reserve?: FinancialConstraint, goal?: Goal): Stat[] {
  return [
    {
      label: goal ? `${goal.name} goal met` : "Goals met",
      render: (m) =>
        m.prob_goal_met != null
          ? chance(m.prob_goal_met)
          : m.goal_shortfall === 0
            ? "On track"
            : `${money(m.goal_shortfall)} short`,
    },
    {
      label: reserve ? `Below the ${money(reserve.amount)} reserve` : "Below the reserve",
      render: (m) => chance(m.prob_below_reserve),
    },
    { label: "Low balance", render: (m) => chance(m.prob_low_balance) },
    { label: "Median ending balance", render: (m) => moneyExact(m.ending_balance) },
  ];
}

function StatGrid({ stats, metrics }: { stats: Stat[]; metrics: ScenarioMetrics }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label}>
          <dt className="text-[11px] uppercase tracking-wider text-faint">{stat.label}</dt>
          <dd className="tnum mt-0.5 text-sm font-medium text-ink">{stat.render(metrics)}</dd>
        </div>
      ))}
    </dl>
  );
}

function CandidateCard({ candidate, stats }: { candidate: OptimizationCandidate; stats: Stat[] }) {
  return (
    <li className="rounded-lg border border-line bg-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-ink">{candidate.label}</p>
        {candidate.meets_constraints ? (
          <Badge tone="good">Keeps your declared limits</Badge>
        ) : (
          <Badge tone="caution">Breaks a declared limit</Badge>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted">{candidate.detail}</p>
      <StatGrid stats={stats} metrics={candidate.metrics} />
      {candidate.violations.length > 0 ? (
        <ul className="mt-3 grid gap-1">
          {candidate.violations.map((violation) => (
            <li key={violation} className="text-xs leading-relaxed text-caution">
              {violation}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function AlternativesPanel({
  optimization,
  reserve,
  goal,
}: {
  optimization: OptimizationResponse;
  reserve?: FinancialConstraint;
  goal?: Goal;
}) {
  const stats = buildStats(reserve, goal);

  return (
    <Card
      title="Other ways to do this"
      subtitle="Each option scored on the same simulated futures. The choice is yours."
    >
      <p className="text-sm leading-relaxed text-ink">{optimization.summary}</p>

      <div className="mt-4 rounded-lg border border-dashed border-line p-4">
        <p className="text-sm font-medium text-baseline">Without the purchase</p>
        <StatGrid stats={stats} metrics={optimization.baseline} />
      </div>

      <ul className="mt-3 grid gap-3">
        {optimization.candidates.map((candidate) => (
          <CandidateCard key={candidate.id} candidate={candidate} stats={stats} />
        ))}
      </ul>

      <h3 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        Assumptions
      </h3>
      <ul className="grid gap-1.5">
        {optimization.assumptions.map((assumption) => (
          <li key={assumption} className="flex gap-2 text-xs leading-relaxed text-muted">
            <span className="text-faint">·</span>
            <span>{assumption}</span>
          </li>
        ))}
      </ul>

      <p className="mt-6 text-xs text-faint">
        {optimization.num_simulations.toLocaleString("en-US")} simulated futures per option.
        Optimization {optimization.optimization_id}.
      </p>
    </Card>
  );
}
