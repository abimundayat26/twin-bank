"use client";

/**
 * Proceed, Sacrifice and Apply Compromise (SPEC section 10).
 *
 * These add to the plan; they never move money, and the confirmation says so.
 * Nothing is written before the reader confirms (CM-1), each button carries
 * exactly one sentence describing what will be saved, and after a commit all
 * three go quiet and the comparison above is marked out of date (CM-6).
 *
 * Sacrifice does not guess a new deadline. It asks the backend for the earliest
 * one that undoes the damage (CM-2) and shows that date before writing
 * anything — the search is the backend's, the decision is the reader's.
 */

import { useState } from "react";
import { OFFLINE_REASON } from "@/lib/offline";
import type { AlternativeRow } from "@/lib/alternatives";
import { compromiseIsApplyable } from "@/lib/alternatives";
import { chance, twinDate } from "@/lib/format";
import type {
  EarliestDateResponse,
  FinancialTwin,
  Goal,
  GoalDateChange,
  SimulationEvent,
  SimulationResponse,
} from "@/lib/types";
import { Card } from "./ui";

/** What a pressed button is waiting to have confirmed. */
interface Pending {
  question: string;
  events: SimulationEvent[];
  goalUpdates?: GoalDateChange[];
}


const STALE = "Your plan changed. Simulate again before deciding.";
const NO_CUTS = "Spending cuts can't be saved yet.";

/**
 * CM-5: Sacrifice is offered only when the purchase actually costs the goal.
 * Either signal counts — a goal can still be met in fewer futures without the
 * median future falling short, and the other way round.
 */
export function purchaseHurtsGoal(simulation: SimulationResponse): boolean {
  const { baseline, counterfactual } = simulation;
  const chanceFell =
    baseline.prob_goal_met != null &&
    counterfactual.prob_goal_met != null &&
    counterfactual.prob_goal_met < baseline.prob_goal_met;
  return chanceFell || counterfactual.goal_shortfall > baseline.goal_shortfall;
}

function Button({
  children,
  onClick,
  disabled,
  reason,
  primary = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  reason?: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={reason}
      className={`rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
        primary
          ? "bg-counter text-canvas hover:brightness-110"
          : "border border-line text-ink hover:bg-raised"
      }`}
    >
      {children}
    </button>
  );
}

export function CommitActions({
  twin,
  simulation,
  goal,
  compromise,
  isOffline = false,
  isCommitting,
  planChanged,
  commitResult,
  commitError,
  onCommit,
  onEarliestDate,
}: {
  twin: FinancialTwin;
  simulation: SimulationResponse;
  /** The earliest-deadline goal; the only one v1 can sacrifice (CM-2, Q5). */
  goal?: Goal;
  compromise?: AlternativeRow;
  isOffline?: boolean;
  isCommitting: boolean;
  planChanged: boolean;
  commitResult?: string;
  commitError?: string;
  onCommit: (events: SimulationEvent[], goalUpdates?: GoalDateChange[]) => Promise<boolean>;
  onEarliestDate: (goalId: string, events: SimulationEvent[]) => Promise<EarliestDateResponse>;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  /** The backend's answer when no deadline restores the goal, or a 422. */
  const [note, setNote] = useState<string>();

  const events = simulation.request.events;
  const purchase = events[0];

  // E-1: it simulates, but a purchase dated today has nothing left to plan for.
  const datedToday = purchase != null && purchase.date <= twin.as_of;
  const blocked = isOffline
    ? OFFLINE_REASON
    : planChanged
      ? STALE
      : datedToday
        ? "A purchase dated today can't be added to the plan."
        : undefined;
  // G-15: nothing may be pressed twice into two records.
  const busy = isCommitting || isSearching;

  function ask(question: string, next: Omit<Pending, "question">) {
    setNote(undefined);
    setPending({ question, ...next });
  }

  function proceed() {
    ask(
      `Add ${purchase.description} on ${twinDate(purchase.date, twin.as_of)} to your plan? This does not move any money.`,
      { events },
    );
  }

  async function sacrifice() {
    if (!goal) return;
    setNote(undefined);
    setIsSearching(true);
    try {
      const answer = await onEarliestDate(goal.id, events);
      if (!answer.earliest_deadline) {
        setNote("No date within 2 years restores this.");
        return;
      }
      const restored =
        answer.prob_goal_met_at_earliest != null
          ? ` The goal is then met in ${chance(answer.prob_goal_met_at_earliest)} of futures.`
          : "";
      ask(
        `Move ${goal.name} from ${twinDate(answer.original_deadline, twin.as_of)} to ` +
          `${twinDate(answer.earliest_deadline, twin.as_of)} and add the purchase?${restored}`,
        {
          events,
          goalUpdates: [
            {
              goal_id: goal.id,
              from_deadline: answer.original_deadline,
              deadline: answer.earliest_deadline,
            },
          ],
        },
      );
    } catch (error: unknown) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSearching(false);
    }
  }

  function applyCompromise() {
    if (!compromise) return;
    ask(`Add ${compromise.detail} to your plan? This does not move any money.`, {
      events: compromise.candidate.events,
    });
  }

  async function confirm() {
    if (!pending) return;
    const saved = await onCommit(pending.events, pending.goalUpdates);
    // A failure keeps the question open, so the reader can try the same answer
    // again once they have read what went wrong.
    if (saved) setPending(null);
  }

  const applyable = compromiseIsApplyable(compromise);

  return (
    <Card title="Decide">
      {planChanged ? (
        <p className="mb-3 text-sm text-caution">
          Out of date: your plan changed. Simulate again.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button onClick={proceed} disabled={busy || blocked != null} reason={blocked} primary>
          Proceed
        </Button>
        {/* CM-5: hidden with no goal (E-4), shown but disabled when the purchase
            does not touch the one there is. */}
        {goal ? (
          <Button
            onClick={() => void sacrifice()}
            disabled={busy || blocked != null || !purchaseHurtsGoal(simulation)}
            reason={blocked ?? (purchaseHurtsGoal(simulation) ? undefined : `This purchase does not set ${goal.name} back.`)}
          >
            {isSearching ? "Finding the earliest date…" : `Sacrifice ${goal.name}`}
          </Button>
        ) : null}
        {compromise ? (
          <Button
            onClick={applyCompromise}
            disabled={busy || blocked != null || !applyable}
            reason={blocked ?? (applyable ? undefined : NO_CUTS)}
          >
            Apply Compromise
          </Button>
        ) : null}
      </div>

      {pending ? (
        <div className="mt-4 rounded-lg border border-line bg-raised p-4">
          <p className="text-sm text-ink">{pending.question}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Button onClick={() => void confirm()} disabled={isCommitting} primary>
              {isCommitting ? "Saving…" : "Yes, save it"}
            </Button>
            <Button onClick={() => setPending(null)} disabled={isCommitting}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {note ? <p className="mt-3 text-sm text-muted">{note}</p> : null}
      {commitError ? <p className="mt-3 text-sm text-bad">{commitError}</p> : null}
      {commitResult ? <p className="mt-3 text-sm text-good">{commitResult}</p> : null}
    </Card>
  );
}
