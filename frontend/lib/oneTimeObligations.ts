/**
 * Reconciling drafted one-time obligations with the ones a twin already holds.
 *
 * A one-time obligation is a known one-off expense the user declares: tuition, a
 * deposit, an annual premium. It is never detected — provenance is always
 * "declared" (SPEC section 2) — and it reaches the twin only once the user has
 * confirmed the draft (SPEC section 3.2). Confirmed, it belongs to the *baseline*
 * future: a commitment already made, not the hypothetical purchase the simulator
 * asks about.
 *
 * `PUT /twin/{user_id}/goals` carries them alongside the goals, and the field
 * replaces rather than appends: an omitted `one_time_obligations` keeps the ones
 * already confirmed, an empty list clears them. So every request built here
 * carries the complete set.
 *
 * Pure functions, no DOM, no fetch, no React. Nothing here invents an obligation
 * or computes money: the drafts come from the compiler and the corrections from
 * the user.
 */

import { isRealDate, parseMoney } from "@/lib/goals";
import type {
  Account,
  DeclaredGoalsRequest,
  FinancialTwin,
  IsoDate,
  OneTimeObligation,
} from "@/lib/types";
import { oneTimeObligations } from "@/lib/twin";

/** How a merged obligation relates to what the twin held before. */
export type ObligationChange = "new" | "updated" | "unchanged";

/** Soonest due first: that is the order the money actually leaves the account. */
export function byDueDate(owed: OneTimeObligation[]): OneTimeObligation[] {
  return [...owed].sort((a, b) => a.due_date.localeCompare(b.due_date));
}

/**
 * The twin's confirmed obligations with the drafts folded in.
 *
 * The compiler derives ids from the name (`one_<slug>`) and only dedupes within
 * a single draft, so describing "car insurance" again yields the id of the one
 * already confirmed. That has to update it in place: the backend rejects a
 * repeated id with "One-time obligation ids must be unique".
 */
export function mergeOneTimeObligations(
  existing: OneTimeObligation[],
  drafts: OneTimeObligation[],
): OneTimeObligation[] {
  // Keyed by id, so a repeated draft collapses to its last version. A Map keeps
  // first-insertion order, which is the order the unmatched drafts append in.
  const pending = new Map<string, OneTimeObligation>();
  for (const draft of drafts) pending.set(draft.id, draft);

  const merged = existing.map((obligation) => {
    const draft = pending.get(obligation.id);
    if (!draft) return obligation;
    pending.delete(obligation.id);
    return draft;
  });

  return [...merged, ...pending.values()];
}

/** The obligations without the one being removed. An unknown id removes nothing. */
export function removeOneTimeObligation(
  existing: OneTimeObligation[],
  obligationId: string,
): OneTimeObligation[] {
  return existing.filter((obligation) => obligation.id !== obligationId);
}

/**
 * The full `PUT /twin/{user_id}/goals` body for removing one obligation.
 *
 * The goals and constraints go back unchanged, for the same reason `withoutGoal`
 * sends them: the PUT replaces the whole declared set, so leaving the emergency
 * reserve out would delete it too.
 */
export function withoutOneTimeObligation(
  twin: FinancialTwin,
  obligationId: string,
): DeclaredGoalsRequest {
  return {
    goals: twin.goals,
    constraints: twin.constraints,
    one_time_obligations: removeOneTimeObligation(oneTimeObligations(twin), obligationId),
  };
}

/**
 * What changed, keyed by obligation id, over the obligations in `merged` — so a
 * review screen can label each row without redoing the comparison.
 */
export function describeObligationChange(
  existing: OneTimeObligation[],
  merged: OneTimeObligation[],
): Map<string, ObligationChange> {
  const before = new Map(existing.map((obligation) => [obligation.id, obligation]));
  const changes = new Map<string, ObligationChange>();
  for (const obligation of merged) {
    const previous = before.get(obligation.id);
    if (!previous) changes.set(obligation.id, "new");
    else changes.set(obligation.id, isSame(previous, obligation) ? "unchanged" : "updated");
  }
  return changes;
}

/** Field by field: a merged obligation is always a fresh object, so identity says nothing. */
function isSame(a: OneTimeObligation, b: OneTimeObligation): boolean {
  return (
    a.name === b.name &&
    a.amount === b.amount &&
    a.due_date === b.due_date &&
    a.account_id === b.account_id &&
    a.mandatory === b.mandatory &&
    a.provenance === b.provenance
  );
}

// --- Correcting a drafted obligation ----------------------------------------

/**
 * What the user typed into a review row. Money and the date are raw strings — an
 * input mid-edit is not a number yet — while the account and the mandatory flag
 * come from controls that cannot hold a half-finished value.
 *
 * A field left `undefined` is untouched and keeps the drafted value.
 */
export interface OneTimeEdit {
  name?: string;
  amount?: string;
  due_date?: string;
  account_id?: string;
  mandatory?: boolean;
}

/** Edits keyed by obligation id. Ids with no row left are ignored. */
export type OneTimeEdits = Record<string, OneTimeEdit | undefined>;

/** One message per bad field. An empty object means the row can be saved. */
export type OneTimeEditErrors = { [K in keyof OneTimeEdit]?: string };

/**
 * Why a row cannot be saved, if it cannot.
 *
 * The same rules `check_one_time_obligations` enforces in
 * `backend/src/backend/twin_store.py`, plus the model's own `amount > 0`,
 * checked here so a typo is caught next to the field instead of as a 400 after
 * Confirm. The backend stays the authority; this only moves the message.
 */
export function validateOneTimeEdit(
  edit: OneTimeEdit | undefined,
  asOf: IsoDate,
  accounts: Account[],
): OneTimeEditErrors {
  const errors: OneTimeEditErrors = {};
  if (!edit) return errors;

  if (edit.name !== undefined && edit.name.trim() === "") {
    errors.name = "Give this a name.";
  }

  if (edit.amount !== undefined) {
    const amount = parseMoney(edit.amount);
    if (amount === null || amount <= 0) errors.amount = "Enter an amount above $0.";
  }

  if (edit.due_date !== undefined) {
    if (!isRealDate(edit.due_date)) errors.due_date = "Enter a date as YYYY-MM-DD.";
    else if (edit.due_date <= asOf) errors.due_date = `Pick a date after ${asOf}.`;
  }

  if (edit.account_id !== undefined && !accounts.some((a) => a.id === edit.account_id)) {
    errors.account_id = "Pick an account you hold.";
  }

  return errors;
}

/** True when nothing on the row is wrong. */
export function isOneTimeEditValid(errors: OneTimeEditErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * The obligations with the user's corrections applied — the set that is both
 * shown and sent, so the review list cannot describe one thing while another is
 * saved.
 *
 * A field that does not validate keeps the drafted value; Confirm is blocked
 * while any row is invalid, so nothing half-typed is ever saved.
 */
export function applyOneTimeEdits(
  owed: OneTimeObligation[],
  edits: OneTimeEdits,
  asOf: IsoDate,
  accounts: Account[],
): OneTimeObligation[] {
  return owed.map((obligation) => {
    const edit = edits[obligation.id];
    if (!edit) return obligation;
    const errors = validateOneTimeEdit(edit, asOf, accounts);
    const next = { ...obligation };

    if (edit.name !== undefined && !errors.name) next.name = edit.name.trim();

    const amount = edit.amount === undefined ? null : parseMoney(edit.amount);
    if (amount !== null && !errors.amount) next.amount = amount;

    if (edit.due_date !== undefined && !errors.due_date) next.due_date = edit.due_date;

    if (edit.account_id !== undefined && !errors.account_id) next.account_id = edit.account_id;

    if (edit.mandatory !== undefined) next.mandatory = edit.mandatory;

    return next;
  });
}

/** An account's name for display, falling back to the id it was stored under. */
export function accountName(accounts: Account[], accountId: string): string {
  return accounts.find((a) => a.id === accountId)?.name ?? accountId;
}
