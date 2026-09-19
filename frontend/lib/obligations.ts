/**
 * How the twin's obligations are grouped for display.
 *
 * Pure, and separate from the panels that render it, because the Overview
 * summarises the same grouping that the Plans page edits: the two must never
 * disagree about what counts as mandatory.
 */

import type { FinancialObligation, FinancialTwin } from "./types";

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
