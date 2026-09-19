"use client";

/**
 * "What is this?" for an obligation the bank could not classify. TwinBank never
 * decides what a transfer means: it offers its most likely guesses and Alex
 * declares the answer. Props only.
 */

import { useState } from "react";
import { money, ordinalDay, percent } from "@/lib/format";
import type { FinancialObligation, ObligationCategory } from "@/lib/types";
import { Badge } from "./ui";

export const CATEGORY_LABELS: Record<ObligationCategory, string> = {
  bill: "Bill",
  savings_transfer: "Savings transfer",
  debt_repayment: "Debt repayment",
  optional_spending: "Optional spending",
  not_recurring: "Not recurring",
};

export function CategoryQuestion({
  obligation,
  isBusy,
  savingScope,
  onAnswer,
}: {
  obligation: FinancialObligation;
  /** A twin update is in flight somewhere on the page; no second one may start. */
  isBusy: boolean;
  /** Which control started it. This question's scope is the obligation's own id. */
  savingScope?: string;
  onAnswer: (category: ObligationCategory) => void;
}) {
  const declared = obligation.declared_category;
  // Every obligation has one of these: only the one being answered says so.
  const isSaving = savingScope === obligation.id;
  const [isChanging, setIsChanging] = useState(false);
  const candidates = obligation.category_candidates ?? [];
  // With no candidates there is nothing to answer the question with, and asking
  // it anyway leaves a dead end the user cannot clear.
  const asking = candidates.length > 0 && (!declared || isChanging);

  function answer(category: ObligationCategory) {
    setIsChanging(false);
    onAnswer(category);
  }

  return (
    <li className="border-b border-line/60 py-2 last:border-0">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-ink">{obligation.name}</p>
          <p className="text-xs text-faint">Due the {ordinalDay(obligation.due_day)}</p>
        </div>
        <span className="tnum shrink-0 text-sm text-ink">{money(obligation.expected_amount)}</span>
      </div>

      {asking ? (
        <div className="mt-2 rounded-lg border border-counter/40 p-3">
          <p className="text-xs font-medium text-ink">What is this?</p>
          <p className="mt-0.5 text-xs text-faint">
            TwinBank can&rsquo;t tell from the transactions alone. Your answer changes the simulation.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {candidates.map((candidate, i) => (
              <button
                key={candidate.category}
                type="button"
                disabled={isBusy}
                onClick={() => answer(candidate.category)}
                className={`rounded-full border px-3 py-1 text-xs disabled:opacity-50 ${
                  i === 0 ? "border-counter text-counter" : "border-line text-muted"
                } ${candidate.category === declared ? "font-semibold" : ""}`}
              >
                {CATEGORY_LABELS[candidate.category]}
                <span className="tnum ml-1 text-faint">
                  {i === 0 ? `Most likely · ${percent(candidate.probability)}` : percent(candidate.probability)}
                </span>
              </button>
            ))}
            {isSaving ? <span className="text-xs text-muted">Saving…</span> : null}
          </div>
        </div>
      ) : declared ? (
        <div className="mt-1 flex items-center gap-2">
          <Badge tone="info">You declared: {CATEGORY_LABELS[declared]}</Badge>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => setIsChanging(true)}
            className="text-xs text-muted underline disabled:opacity-50"
          >
            Change
          </button>
          {isSaving ? <span className="text-xs text-muted">Saving…</span> : null}
        </div>
      ) : null}
    </li>
  );
}
