"use client";

/**
 * Alex's own low-balance line for checking. Without one, the simulator falls back to
 * DEFAULT_LOW_BALANCE_THRESHOLD (see the simulation assumptions). Props only.
 */

import { useState, type FormEvent } from "react";
import { money } from "@/lib/format";
import { MINIMUM_BALANCE_SCOPE } from "@/lib/scopes";
import { OFFLINE_REASON } from "@/lib/offline";
import { DEFAULT_LOW_BALANCE_THRESHOLD, type FinancialConstraint } from "@/lib/types";
import { Card, ProvenanceTag } from "./ui";

export function MinimumBalanceCard({
  minimum,
  isBusy,
  isOffline = false,
  savingScope,
  onSave,
}: {
  minimum?: FinancialConstraint;
  /** A twin update is in flight somewhere on the page; no second one may start. */
  isBusy: boolean;
  isOffline?: boolean;
  /** Which control started it, so only that one says "Saving…". */
  savingScope?: string;
  onSave: (amount: number) => void;
}) {
  const isSaving = savingScope === MINIMUM_BALANCE_SCOPE;
  const [draft, setDraft] = useState(minimum ? String(minimum.amount) : "");
  const amount = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(amount) && amount >= 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid && !isOffline) onSave(amount);
  }

  return (
    <Card title="Minimum checking balance" subtitle="Where a “low balance” starts for you">
      {minimum ? (
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <p className="tnum text-3xl font-semibold text-ink">{money(minimum.amount)}</p>
          <ProvenanceTag provenance={minimum.provenance} />
        </div>
      ) : (
        <p className="mb-3 text-sm text-muted">
          Not set. The simulation assumes {money(DEFAULT_LOW_BALANCE_THRESHOLD)}.
        </p>
      )}
      <form onSubmit={submit} className="flex items-center gap-2">
        <label className="sr-only" htmlFor="minimum-balance">
          Minimum checking balance in dollars
        </label>
        <input
          id="minimum-balance"
          type="number"
          min={0}
          step={50}
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={String(DEFAULT_LOW_BALANCE_THRESHOLD)}
          className="tnum w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-counter focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter"
        />
        <button
          type="submit"
          disabled={!valid || isBusy || isOffline}
          title={isOffline ? OFFLINE_REASON : undefined}
          className="shrink-0 rounded-lg bg-counter px-4 py-2 text-sm font-semibold text-canvas transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? "Saving…" : minimum ? "Update" : "Set"}
        </button>
      </form>
    </Card>
  );
}
