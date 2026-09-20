/**
 * Small reads over the twin that more than one page needs.
 *
 * The goal ordering matters: the backend's default horizon ends at the earliest
 * goal deadline, so "the first goal" is the one that decides where every
 * projection stops. Three pages depended on that ordering separately; it lives
 * here so they cannot drift apart.
 */

import type { FinancialConstraint, FinancialTwin, Goal, OneTimeObligation } from "./types";

/** Soonest deadline first. */
export function byDeadline(goals: Goal[]): Goal[] {
  return [...goals].sort((a, b) => a.deadline.localeCompare(b.deadline));
}

/** The goal whose deadline sets the simulation horizon, if there is one. */
export function primaryGoal(twin: FinancialTwin): Goal | undefined {
  return byDeadline(twin.goals)[0];
}

export function emergencyReserve(twin: FinancialTwin): FinancialConstraint | undefined {
  return twin.constraints.find((c) => c.type === "minimum_reserve");
}

/**
 * The twin's declared one-time obligations. A backend that predates the contract
 * omits the field entirely, and an offline fallback may too, so the absent case is
 * "none declared" — never a reason to render nothing at all.
 */
export function oneTimeObligations(twin: FinancialTwin): OneTimeObligation[] {
  return twin.one_time_obligations ?? [];
}
