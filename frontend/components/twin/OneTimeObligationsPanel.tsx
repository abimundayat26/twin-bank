"use client";

/**
 * The one-time obligations Alex has confirmed: tuition, a deposit, an annual
 * premium — money already owed on one known date.
 *
 * Kept apart from `ObligationsPanel`, which shows the recurring bills TwinBank
 * *detected*. These are never detected: provenance is always "declared" (SPEC
 * section 2), and each one reached the twin only because Alex confirmed the
 * draft. A confirmed one is part of the baseline future, which is what
 * distinguishes it from the hypothetical purchase in the simulator.
 *
 * Removal asks once more before it calls `onRemove`, as `GoalCard` does: it
 * cannot be undone from here, the obligation would have to be declared again.
 */

import { useState } from "react";
import { longDate, money } from "@/lib/format";
import { accountName, byDueDate } from "@/lib/oneTimeObligations";
import { oneTimeObligations } from "@/lib/twin";
import type { FinancialTwin, OneTimeObligation } from "@/lib/types";
import { Badge, Card, ProvenanceTag } from "../ui";

export function OneTimeObligationsPanel({
  twin,
  isBusy = false,
  savingScope,
  onRemove,
}: {
  twin: FinancialTwin;
  /** A twin update is in flight somewhere on the page; no second one may start. */
  isBusy?: boolean;
  /** Which control started it. This panel's scope is the obligation's own id. */
  savingScope?: string;
  onRemove?: (obligationId: string) => void;
}) {
  // `oneTimeObligations` reads the absent field as "none declared": a backend
  // that predates the contract omits it, and that is not an error to report.
  const owed = byDueDate(oneTimeObligations(twin));

  return (
    <Card
      title="One-time obligations"
      subtitle="Known one-off expenses you declared. They are part of your baseline future."
    >
      {owed.length > 0 ? (
        <ul>
          {owed.map((obligation) => (
            <OwedRow
              key={obligation.id}
              obligation={obligation}
              accountLabel={accountName(twin.accounts, obligation.account_id)}
              isBusy={isBusy}
              isSaving={savingScope === obligation.id}
              onRemove={onRemove}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          None declared. Describe one — &ldquo;I owe $450 for car insurance on October
          15&rdquo; — and TwinBank asks for whatever it needs before you confirm the draft.
        </p>
      )}
    </Card>
  );
}

function OwedRow({
  obligation,
  accountLabel,
  isBusy,
  isSaving,
  onRemove,
}: {
  obligation: OneTimeObligation;
  accountLabel: string;
  isBusy: boolean;
  isSaving: boolean;
  onRemove?: (obligationId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    // Stacks and wraps rather than truncating, like `Row`: a clipped obligation
    // name is unrecoverable for a sighted reader (SPEC section 7.1).
    <li className="border-b border-line py-2 last:border-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="break-words text-sm text-ink">{obligation.name}</p>
          <p className="text-xs text-faint">
            Due {longDate(obligation.due_date)} · from {accountLabel}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:shrink-0">
          <Badge tone={obligation.mandatory ? "caution" : "neutral"}>
            {obligation.mandatory ? "Mandatory" : "Optional"}
          </Badge>
          <ProvenanceTag provenance={obligation.provenance} />
          <span className="tnum break-words text-right text-sm text-ink">
            {money(obligation.amount)}
          </span>
        </div>
      </div>

      {onRemove ? (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-sm">
          {confirming ? (
            <>
              <span className="mr-auto text-muted">Remove this obligation?</span>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={isBusy}
                className="rounded-lg border border-line px-3 py-1.5 text-muted transition hover:text-ink disabled:opacity-50"
              >
                Keep it
              </button>
              <button
                type="button"
                onClick={() => onRemove(obligation.id)}
                disabled={isBusy}
                className="rounded-lg border border-bad/70 px-3 py-1.5 font-semibold text-bad transition hover:bg-bad/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? "Removing…" : "Remove"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={isBusy}
              className="rounded-lg px-3 py-1.5 text-muted transition hover:text-bad disabled:opacity-50"
            >
              Remove {obligation.name}
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}
