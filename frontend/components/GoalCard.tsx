/** One declared savings goal. Progress is read from the contract, not derived. */

import { money, longDate } from "@/lib/format";
import type { Goal } from "@/lib/types";
import { Card, ProvenanceTag } from "./ui";

export function GoalCard({ goal }: { goal: Goal }) {
  // Display-only bar width, clamped. The dollar figures below are the contract's.
  const filled = Math.min(100, Math.max(0, (goal.current_amount / goal.target_amount) * 100));

  return (
    <Card title="Active savings goal">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-lg font-medium text-ink">{goal.name}</p>
          <p className="text-sm text-muted">by {longDate(goal.deadline)}</p>
        </div>
        <ProvenanceTag provenance={goal.provenance} />
      </div>

      <p className="tnum mt-4 text-3xl font-semibold text-ink">
        {money(goal.current_amount)}
        <span className="text-lg font-normal text-faint"> / {money(goal.target_amount)}</span>
      </p>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-raised">
        <div className="h-full rounded-full bg-baseline" style={{ width: `${filled}%` }} />
      </div>
    </Card>
  );
}
