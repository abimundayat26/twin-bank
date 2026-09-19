"use client";

/**
 * One declared savings goal. Progress is read from the contract, not derived.
 * Removal asks once more before it calls `onRemove`, since it cannot be undone
 * from here: the goal would have to be typed again.
 */

import { useState } from "react";
import { money, longDate } from "@/lib/format";
import type { Goal } from "@/lib/types";
import { Card, ProvenanceTag } from "./ui";

export function GoalCard({
  goal,
  title = "Active savings goal",
  subtitle,
  isSaving = false,
  onRemove,
}: {
  goal: Goal;
  /** Every declared goal gets a card, so the caller says which one this is. */
  title?: string;
  subtitle?: string;
  isSaving?: boolean;
  onRemove?: (goalId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // Display-only bar width, clamped. The dollar figures below are the contract's.
  const filled = Math.min(100, Math.max(0, (goal.current_amount / goal.target_amount) * 100));

  return (
    <Card title={title} subtitle={subtitle}>
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

      {onRemove ? (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm">
          {confirming ? (
            <>
              <span className="mr-auto text-muted">Remove this goal?</span>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={isSaving}
                className="rounded-lg border border-line px-3 py-1.5 text-muted transition hover:text-ink disabled:opacity-50"
              >
                Keep it
              </button>
              <button
                type="button"
                onClick={() => onRemove(goal.id)}
                disabled={isSaving}
                className="rounded-lg border border-bad/40 px-3 py-1.5 font-semibold text-bad transition hover:bg-bad/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? "Removing…" : "Remove"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={isSaving}
              className="rounded-lg px-3 py-1.5 text-muted transition hover:text-bad disabled:opacity-50"
            >
              Remove goal
            </button>
          )}
        </div>
      ) : null}
    </Card>
  );
}
