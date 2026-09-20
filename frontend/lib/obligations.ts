/**
 * How the twin's obligations are grouped for display.
 *
 * Pure, and separate from the panels that render it, because the Overview
 * summarises the same grouping that the Plans page edits: the two must never
 * disagree about what counts as mandatory.
 */

import { oneTimeObligations } from "./twin";
import type {
  FinancialObligation,
  FinancialTwin,
  ObligationCategory,
  ObligationsPayload,
} from "./types";

const CATEGORY_LABELS: Record<ObligationCategory, string> = {
  bill: "Bill",
  savings_transfer: "Savings transfer",
  debt_repayment: "Debt repayment",
  optional_spending: "Optional spending",
  not_recurring: "Not recurring",
};

/** Alex's declared category overrides the bank's observed mandatory flag. */
export function isMandatory(obligation: FinancialObligation): boolean {
  const declared = obligation.declared_category;
  if (declared === "bill" || declared === "debt_repayment") return true;
  if (declared) return false;
  return obligation.mandatory;
}

/** An obligation TwinBank could not classify on its own, so it has to ask. */
export function needsAnswer(obligation: FinancialObligation): boolean {
  return (obligation.category_candidates?.length ?? 0) > 0;
}

export interface GroupedObligations {
  /** Mandatory bills the projection must cover. */
  upcoming: FinancialObligation[];
  /** Recurring, but not mandatory. */
  recurring: FinancialObligation[];
  /** Declared "not recurring", so left out of the projection entirely. */
  excluded: FinancialObligation[];
}

export function groupObligations(twin: FinancialTwin): GroupedObligations {
  const excluded = twin.obligations.filter((o) => o.declared_category === "not_recurring");
  return {
    upcoming: twin.obligations.filter(isMandatory),
    recurring: twin.obligations.filter(
      (o) => !isMandatory(o) && o.declared_category !== "not_recurring",
    ),
    excluded,
  };
}

/** The questions waiting for the user, which the Overview counts and Plans asks. */
export function openQuestions(twin: FinancialTwin): FinancialObligation[] {
  return twin.obligations.filter(needsAnswer);
}

/**
 * Orders rows the way the read endpoint does, so the offline listing and the
 * online one agree (OB-10). Sorting a list is display work the frontend is
 * allowed to do (G-6); nothing here derives a value.
 */
function byKeys<T>(key: (row: T) => Array<string | number>) {
  return (a: T, b: T): number => {
    const left = key(a);
    const right = key(b);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] < right[index]) return -1;
      if (left[index] > right[index]) return 1;
    }
    return 0;
  };
}

/**
 * Shape the already-loaded saved twin like the read endpoint while offline.
 * This only renames contract fields, orders the rows and removes candidate
 * probabilities; it does not derive balances, dates, risk, or any other
 * financial value.
 */
export function offlineObligations(twin: FinancialTwin): ObligationsPayload {
  const accountNames = new Map(twin.accounts.map((account) => [account.id, account.name]));
  return {
    user_id: twin.user_id,
    as_of: twin.as_of,
    recurring: twin.obligations
      .map((obligation) => ({
        id: obligation.id,
        name: obligation.name,
        amount: obligation.expected_amount,
        frequency: "monthly" as const,
        due_day: obligation.due_day,
        active: obligation.active ?? true,
        origin: (obligation.provenance === "observed" ? "detected" : "declared") as
          | "detected"
          | "declared",
        category_label: obligation.declared_category
          ? CATEGORY_LABELS[obligation.declared_category]
          : null,
        needs_answer: needsAnswer(obligation) && !obligation.declared_category,
        options: (obligation.category_candidates ?? []).map((candidate) => ({
          category: candidate.category,
          label: CATEGORY_LABELS[candidate.category],
        })),
      }))
      .sort(byKeys((row) => [row.due_day, row.name.toLowerCase(), row.name, row.id])),
    one_time: oneTimeObligations(twin)
      .filter((obligation) => obligation.due_date > twin.as_of)
      .map((obligation) => ({
        id: obligation.id,
        name: obligation.name,
        amount: obligation.amount,
        due_date: obligation.due_date,
        account_id: obligation.account_id,
        account_name: accountNames.get(obligation.account_id) ?? obligation.account_id,
        mandatory: obligation.mandatory,
      }))
      .sort(byKeys((row) => [row.due_date, row.name.toLowerCase(), row.name, row.id])),
  };
}
