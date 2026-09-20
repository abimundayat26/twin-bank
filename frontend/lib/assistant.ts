/**
 * How a proposal reads on its card, and how a quick reply maps back to a route.
 *
 * Pure: it formats what the Assistant drafted and never decides anything
 * financial. The card copy is fixed by SPEC section 9.2 (PL-4) so every action
 * type reads the same way every time, rather than each card inventing a
 * sentence. Amounts and dates go through the shared formatters (G-1, G-2).
 */

import { CATEGORY_LABELS } from "@/components/CategoryQuestion";
import { displayDate, money, ordinalDay } from "./format";
import type {
  AssistantQuestion,
  FinancialTwin,
  GoalChanges,
  ObligationCategory,
  OneTimeObligationChanges,
  Proposal,
  RecurringObligationChanges,
  SimulatePrefill,
} from "./types";

/** One line of detail the fixed title does not already carry. */
export interface CardField {
  label: string;
  value: string;
}

export interface ProposalCardCopy {
  title: string;
  fields: CardField[];
}

/** Accepting adds something new, or changes something already on the twin (PL-5). */
export function acceptedLabel(proposal: Proposal): "Added" | "Updated" {
  return proposal.action_type === "ADD_GOAL" || proposal.action_type === "ADD_OBLIGATION"
    ? "Added"
    : "Updated";
}

function accountName(twin: FinancialTwin, accountId: string): string {
  return twin.accounts.find((a) => a.id === accountId)?.name ?? "your account";
}

/** "target amount to $2,500 and target date to June 1, 2027". */
function goalChangeText(changes: GoalChanges, asOf: string): string {
  const parts: string[] = [];
  if (changes.name !== undefined) parts.push(`name to “${changes.name}”`);
  if (changes.target_amount !== undefined) {
    parts.push(`target amount to ${money(changes.target_amount)}`);
  }
  if (changes.deadline !== undefined) {
    parts.push(`target date to ${displayDate(changes.deadline, asOf)}`);
  }
  if (changes.current_amount !== undefined) {
    parts.push(`saved so far to ${money(changes.current_amount)}`);
  }
  return parts.join(" and ");
}

function recurringChangeText(changes: RecurringObligationChanges): string {
  const parts: string[] = [];
  if (changes.name !== undefined) parts.push(`name to “${changes.name}”`);
  if (changes.amount !== undefined) parts.push(`amount to ${money(changes.amount)}`);
  if (changes.due_day !== undefined) parts.push(`due day to the ${ordinalDay(changes.due_day)}`);
  // "active: false" is a pause, not a deletion: a detected bill cannot be deleted (A7).
  if (changes.active !== undefined) parts.push(`status to ${changes.active ? "Active" : "Paused"}`);
  return parts.join(" and ");
}

function oneTimeChangeText(
  changes: OneTimeObligationChanges,
  twin: FinancialTwin,
  asOf: string,
): string {
  const parts: string[] = [];
  if (changes.name !== undefined) parts.push(`name to “${changes.name}”`);
  if (changes.amount !== undefined) parts.push(`amount to ${money(changes.amount)}`);
  if (changes.due_date !== undefined) {
    parts.push(`due date to ${displayDate(changes.due_date, asOf)}`);
  }
  if (changes.account_id !== undefined) {
    parts.push(`account to ${accountName(twin, changes.account_id)}`);
  }
  if (changes.mandatory !== undefined) {
    parts.push(`must pay to ${changes.mandatory ? "Yes" : "No"}`);
  }
  return parts.join(" and ");
}

/**
 * The card's wording, fixed per action type (PL-4).
 *
 * `twin` supplies only names the draft refers to by id (the account a bill is
 * paid from) and the `as_of` the year rule is measured against.
 */
export function describeProposal(proposal: Proposal, twin: FinancialTwin): ProposalCardCopy {
  const asOf = twin.as_of;
  switch (proposal.action_type) {
    case "ADD_GOAL": {
      const { name, target_amount, deadline } = proposal.goal;
      return {
        title: `Add goal: ${name}, ${money(target_amount)} by ${displayDate(deadline, asOf)}`,
        fields: [],
      };
    }
    case "UPDATE_GOAL":
      return {
        title: `Change ${proposal.goal_name}: ${goalChangeText(proposal.changes, asOf)}`,
        fields: [],
      };
    case "ADD_OBLIGATION": {
      const { name, amount, due_date, account_id, mandatory } = proposal.obligation;
      return {
        title:
          `Add bill: ${name}, ${money(amount)} on ${displayDate(due_date, asOf)}, ` +
          `paid from ${accountName(twin, account_id)}`,
        // Whether it must be paid changes what the simulator may skip, so it is
        // on the card rather than hidden behind Accept.
        fields: [{ label: "Must pay", value: mandatory ? "Yes" : "No" }],
      };
    }
    case "UPDATE_OBLIGATION": {
      const changes =
        proposal.kind === "recurring"
          ? recurringChangeText(proposal.recurring_changes ?? {})
          : oneTimeChangeText(proposal.one_time_changes ?? {}, twin, asOf);
      return { title: `Change ${proposal.obligation_name}: ${changes}`, fields: [] };
    }
    case "SET_CONSTRAINT": {
      const { type, amount } = proposal.constraint;
      const covers = type === "minimum_reserve" ? "checking plus savings" : "checking";
      return { title: `Keep at least ${money(amount)} in ${covers}`, fields: [] };
    }
    case "CLASSIFY_OBLIGATION": {
      const { obligation_name, category } = proposal.classification;
      return {
        title: `Treat ${obligation_name} as ${CATEGORY_LABELS[category]}`,
        fields: [],
      };
    }
  }
}

/**
 * The category behind a quick reply on an opening question.
 *
 * The backend sends the labels only (G-5: no probabilities, no enum names), so
 * the answer is mapped back here rather than guessed. An unknown label returns
 * undefined and the click does nothing, which is better than sending a category
 * the user did not pick.
 */
export function categoryForLabel(label: string): ObligationCategory | undefined {
  const entry = Object.entries(CATEGORY_LABELS).find(([, value]) => value === label);
  return entry?.[0] as ObligationCategory | undefined;
}

/**
 * The obligation an opening question is about.
 *
 * AS-9 builds the question from a detected obligation and puts its name in
 * `fragment`; the id is not in the payload, so it is resolved by name here.
 */
export function obligationForQuestion(
  twin: FinancialTwin,
  question: AssistantQuestion,
): string | undefined {
  return twin.obligations.find((o) => o.name === question.fragment)?.id;
}

/**
 * The Purchase Simulator, filled in but not run (PL-6, AS-8).
 *
 * The values travel as query parameters so the link is an ordinary navigation:
 * the Simulator reads them into its form and waits for the user to press
 * Simulate. Nothing here runs a simulation or says anything about affording it.
 */
export function simulateHref(prefill: SimulatePrefill): string {
  const params = new URLSearchParams({
    description: prefill.description,
    amount: String(prefill.amount),
  });
  if (prefill.date) params.set("date", prefill.date);
  return `/simulate?${params.toString()}`;
}

/** What the Simulator's form starts with when a what-if sent the user there. */
export interface PrefillValues {
  description?: string;
  amount?: string;
  date?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The other end of `simulateHref`: the query parameters, read back into form
 * values (PL-6).
 *
 * A parameter that is not usable is dropped rather than repaired, so a hand-
 * edited or truncated URL leaves the form on its defaults instead of starting
 * it on a number nobody typed. Nothing here is submitted: filling the form is
 * the whole of it (AS-8).
 *
 * `null` is accepted because that is what `useSearchParams` gives where there is
 * no query string to read; the form then starts on its defaults.
 */
export function readPrefillParams(params: URLSearchParams | null): PrefillValues | undefined {
  if (!params) return undefined;
  const prefill: PrefillValues = {};

  const description = params.get("description")?.trim();
  if (description) prefill.description = description;

  const amount = params.get("amount")?.trim();
  if (amount) {
    const parsed = Number(amount);
    if (Number.isFinite(parsed) && parsed > 0) prefill.amount = amount;
  }

  const date = params.get("date")?.trim();
  if (date && ISO_DATE.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    prefill.date = date;
  }

  return Object.keys(prefill).length > 0 ? prefill : undefined;
}
