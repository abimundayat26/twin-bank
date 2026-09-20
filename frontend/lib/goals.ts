/**
 * Reconciling compiled goal drafts with the goals a twin already holds.
 *
 * `PUT /twin/{user_id}/goals` replaces the whole declared set, and the backend
 * resets the emergency reserve from whatever `constraints` the body carries. So
 * sending only the goal the user just typed would erase the rest of their goals
 * and their $1,500 reserve. These functions build the complete set to send.
 *
 * Pure functions, no DOM, no fetch, no React. Nothing here calculates money or
 * invents a goal: both lists come from the backend, and the only judgement made
 * is which entry of a matching pair to keep (SPEC 2 — goals are declared, never
 * inferred).
 */

import type {
  DeclaredGoalsRequest,
  FinancialConstraint,
  FinancialTwin,
  Goal,
  GoalClarification,
  IsoDate,
} from "@/lib/types";

/** How a merged goal relates to what the twin held before. */
export type GoalChange = "new" | "updated" | "unchanged";

/**
 * The twin's goals with the drafts folded in.
 *
 * The compiler derives ids from the goal name (`goal_<slug>`), so retyping
 * "summer housing" yields the existing id and must update that goal in place
 * rather than duplicate it — the backend rejects a repeated id with
 * "Goal ids must be unique".
 */
export function mergeGoals(existing: Goal[], drafts: Goal[]): Goal[] {
  // Keyed by id, so a repeated draft collapses to its last version. A Map keeps
  // first-insertion order, which is the order the unmatched drafts append in.
  const pending = new Map<string, Goal>();
  for (const draft of drafts) pending.set(draft.id, draft);

  const merged = existing.map((goal) => {
    const draft = pending.get(goal.id);
    if (!draft) return goal;
    pending.delete(goal.id);
    // The compiler always emits 0 here, but current_amount is progress the user
    // has already made; every other field is the draft's.
    return { ...draft, current_amount: goal.current_amount };
  });

  return [...merged, ...pending.values()];
}

/**
 * The twin's constraints with the drafted ones folded in.
 *
 * At most one constraint per type — the backend rejects a second with
 * "At most one <type> constraint". A type the drafts never mention is carried
 * through untouched, which is what keeps the emergency reserve alive when the
 * user types a goal that says nothing about emergencies.
 */
export function mergeConstraints(
  existing: FinancialConstraint[],
  drafts: FinancialConstraint[],
): FinancialConstraint[] {
  const pending = new Map<FinancialConstraint["type"], FinancialConstraint>();
  for (const draft of drafts) pending.set(draft.type, draft);

  const merged = existing.map((constraint) => {
    const draft = pending.get(constraint.type);
    if (!draft) return constraint;
    pending.delete(constraint.type);
    return draft;
  });

  return [...merged, ...pending.values()];
}

/** The goals without the one being removed. An unknown id removes nothing. */
export function removeGoal(existing: Goal[], goalId: string): Goal[] {
  return existing.filter((goal) => goal.id !== goalId);
}

/**
 * The full `PUT /twin/{user_id}/goals` body for removing one goal.
 *
 * Every other goal and every constraint go back unchanged: the PUT replaces the
 * whole declared set, so leaving the reserve out would delete it too.
 */
export function withoutGoal(twin: FinancialTwin, goalId: string): DeclaredGoalsRequest {
  return { goals: removeGoal(twin.goals, goalId), constraints: twin.constraints };
}

/**
 * What changed, keyed by goal id, over the goals in `merged` — so a review
 * screen can label each row without redoing the comparison.
 */
export function describeChange(existing: Goal[], merged: Goal[]): Map<string, GoalChange> {
  const before = new Map(existing.map((goal) => [goal.id, goal]));
  const changes = new Map<string, GoalChange>();
  for (const goal of merged) {
    const previous = before.get(goal.id);
    if (!previous) changes.set(goal.id, "new");
    else changes.set(goal.id, isSameGoal(previous, goal) ? "unchanged" : "updated");
  }
  return changes;
}

/** Field by field: a merged goal is always a fresh object, so identity says nothing. */
function isSameGoal(a: Goal, b: Goal): boolean {
  return (
    a.name === b.name &&
    a.target_amount === b.target_amount &&
    a.deadline === b.deadline &&
    a.current_amount === b.current_amount &&
    a.provenance === b.provenance
  );
}

// --- Answering a clarification ----------------------------------------------

/**
 * `POST /goals/compile` is stateless and there is no endpoint for answering a
 * question: the compiler only ever reads text. So an answer is folded back into
 * the words the user wrote and the whole thing is compiled again.
 *
 * Nothing here invents a value. The answer is the user's own, and the only
 * judgement is where in their sentence it belongs.
 */
export interface ClarificationAnswer {
  clarification: GoalClarification;
  /** What the user typed in the box under the question. */
  answer: string;
}

/** Leading words that already say "this is a date", so "by" would be doubled. */
const DEADLINE_LEAD = /^(?:by|before|until|no later than|on|in|within)\b/i;
/** A bare number: the compiler reads money, so it needs the dollar sign. */
const BARE_NUMBER = /^[\d.,]+$/;

/**
 * The fragment the question was about, rewritten with the answer in it.
 *
 * An amount goes before the "for …" phrase, because the compiler reads
 * everything after "for" as the goal's name. A `type` answer replaces the
 * fragment outright: the question is which of two readings the user meant, and
 * only saying that part again can settle it.
 */
export function answerSentence(clarification: GoalClarification, answer: string): string {
  const said = answer.trim();
  const fragment = clarification.fragment.trim();
  if (!said) return fragment;
  switch (clarification.field) {
    case "amount": {
      const amount = BARE_NUMBER.test(said) ? `$${said}` : said;
      return fragment.includes(" for ")
        ? fragment.replace(" for ", ` ${amount} for `)
        : `${fragment} ${amount}`;
    }
    case "deadline":
      return `${fragment} ${DEADLINE_LEAD.test(said) ? said : `by ${said}`}`;
    case "name":
      return `${fragment} ${/^for\b/i.test(said) ? said : `for ${said}`}`;
    case "account":
      return `${fragment} ${/^(from|out of|using)\b/i.test(said) ? said : `from ${said}`}`;
    case "mandatory":
      return `${fragment}, ${said}`;
    // "type" and "intent" both ask which of two readings was meant. Only saying
    // that part again can settle it, so the answer replaces the fragment.
    case "type":
    case "intent":
      return said;
  }
}

/**
 * The text to compile again, with each answer folded in where its question came
 * from. The rest of what the user wrote is left alone, so answering one question
 * cannot quietly drop another goal.
 *
 * An answer whose fragment is no longer in the text — the user edited the box
 * since — is added as its own sentence rather than dropped.
 */
export function appendAnswers(text: string, answers: ClarificationAnswer[]): string {
  let result = text;
  // Two questions usually come from the same clause — one for the amount, one for
  // the deadline — so the second answer is folded into what the first left behind.
  const rewritten = new Map<string, string>();
  for (const { clarification, answer } of answers) {
    if (!answer.trim()) continue;
    const fragment = clarification.fragment.trim();
    const current = rewritten.get(fragment) ?? fragment;
    const sentence = answerSentence({ ...clarification, fragment: current }, answer);
    rewritten.set(fragment, sentence);
    const at = current ? result.indexOf(current) : -1;
    result =
      at === -1
        ? `${result.replace(/[\s.]*$/, "")}. ${sentence}`
        : result.slice(0, at) + sentence + result.slice(at + current.length);
  }
  return result;
}

// --- Correcting a drafted goal ----------------------------------------------

/**
 * What the user typed into a review row, as raw strings — an input mid-edit is
 * not a number yet, and blanking a field should not silently mean zero dollars.
 * A field left `undefined` is untouched and keeps the drafted value.
 */
export interface GoalEdit {
  target_amount?: string;
  deadline?: string;
  current_amount?: string;
}

/** Edits keyed by goal id. Ids with no row left are ignored. */
export type GoalEdits = Record<string, GoalEdit | undefined>;

/** One message per bad field. An empty object means the row can be saved. */
export type GoalEditErrors = { [K in keyof GoalEdit]?: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dollars from what was typed: `$1,200` and `1200` are the same number.
 *
 * Exported for `lib/oneTimeObligations`, whose review rows sit in the same
 * composer and must read a typed amount exactly the way these ones do.
 */
export function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** A real calendar day, not just ISO-shaped: 2026-02-31 is neither. */
export function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Blank progress means none saved yet; blank anything else is missing, not zero. */
function parseProgress(raw: string): number | null {
  return raw.trim() === "" ? 0 : parseMoney(raw);
}

/**
 * Why a row cannot be saved, if it cannot.
 *
 * The same rules the backend enforces on `PUT /twin/{user_id}/goals`, checked
 * here so a typo is caught next to the field instead of as a 400 after Confirm.
 * The backend also refuses a deadline further out than its horizon; that one
 * stays server-side, since the limit is not part of the contract.
 */
export function validateEdit(goal: Goal, edit: GoalEdit | undefined, asOf: IsoDate): GoalEditErrors {
  const errors: GoalEditErrors = {};
  if (!edit) return errors;

  let target = goal.target_amount;
  if (edit.target_amount !== undefined) {
    const amount = parseMoney(edit.target_amount);
    if (amount === null || amount <= 0) errors.target_amount = "Enter an amount above $0.";
    else target = amount;
  }

  if (edit.deadline !== undefined) {
    if (!isRealDate(edit.deadline)) errors.deadline = "Enter a date as YYYY-MM-DD.";
    else if (edit.deadline <= asOf) errors.deadline = `Pick a date after ${asOf}.`;
  }

  if (edit.current_amount !== undefined) {
    const saved = parseProgress(edit.current_amount);
    if (saved === null) errors.current_amount = "Enter an amount, or leave it empty.";
    else if (saved < 0) errors.current_amount = "This cannot be negative.";
    else if (saved > target) errors.current_amount = "This is more than the target.";
  }

  return errors;
}

/** True when nothing on the row is wrong. */
export function isEditValid(errors: GoalEditErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * The goals with the user's corrections applied — the set that is both shown and
 * sent, so the review list cannot describe one thing while another is saved.
 *
 * A field that does not validate keeps the drafted value; Confirm is blocked
 * while any row is invalid, so nothing half-typed is ever saved.
 */
export function applyEdits(goals: Goal[], edits: GoalEdits, asOf: IsoDate): Goal[] {
  return goals.map((goal) => {
    const edit = edits[goal.id];
    if (!edit) return goal;
    const errors = validateEdit(goal, edit, asOf);
    const next = { ...goal };

    const target = edit.target_amount === undefined ? null : parseMoney(edit.target_amount);
    if (target !== null && !errors.target_amount) next.target_amount = target;

    if (edit.deadline !== undefined && !errors.deadline) next.deadline = edit.deadline;

    const saved = edit.current_amount === undefined ? null : parseProgress(edit.current_amount);
    if (saved !== null && !errors.current_amount) next.current_amount = saved;

    return next;
  });
}
