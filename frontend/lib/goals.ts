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

import type { DeclaredGoalsRequest, FinancialConstraint, FinancialTwin, Goal } from "@/lib/types";

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
