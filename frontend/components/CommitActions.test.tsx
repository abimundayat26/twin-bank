import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AlternativeRow } from "@/lib/alternatives";
import mockSimulation from "@/lib/mock/simulation.json";
import mockTwin from "@/lib/mock/twin.json";
import type {
  EarliestDateResponse,
  FinancialTwin,
  OptimizationCandidate,
  SimulationResponse,
} from "@/lib/types";
import { CommitActions } from "./CommitActions";

const TWIN = mockTwin as unknown as FinancialTwin;
const GOAL = TWIN.goals[0];
const SIMULATION = mockSimulation as unknown as SimulationResponse;

/** A purchase dated after as_of, which is the only kind that can be committed. */
const EVENT = { ...SIMULATION.request.events[0], date: "2026-09-20" };

/** The laptop: it costs the goal, so Sacrifice is offered. */
const HURTS: SimulationResponse = {
  ...SIMULATION,
  request: { ...SIMULATION.request, events: [EVENT] },
  baseline: { ...SIMULATION.baseline, prob_goal_met: 0.768, goal_shortfall: 0 },
  counterfactual: { ...SIMULATION.counterfactual, prob_goal_met: 0.1, goal_shortfall: 504 },
};

const ANSWER: EarliestDateResponse = {
  goal_id: GOAL.id,
  original_deadline: "2027-05-01",
  earliest_deadline: "2027-05-31",
  baseline_prob_goal_met: 0.768,
  prob_goal_met_at_earliest: 0.86,
  searched_until: "2028-09-17",
};

function compromiseRow(
  candidate: Partial<OptimizationCandidate> = {},
): AlternativeRow {
  return {
    key: "compromise",
    label: "Compromise",
    detail: "Take $300 from savings and buy it now",
    candidate: {
      id: "cand_from_savings",
      kind: "from_savings",
      label: "From savings",
      detail: "Take $300 from savings and buy it now",
      events: [{ ...EVENT, account_id: "acc_savings" }],
      spending_adjustments: [],
      metrics: SIMULATION.counterfactual,
      meets_constraints: true,
      violations: [],
      ...candidate,
    },
    metrics: SIMULATION.counterfactual,
    violations: [],
  };
}

function renderActions(props: Partial<Parameters<typeof CommitActions>[0]> = {}) {
  const onCommit = vi.fn().mockResolvedValue(true);
  const onEarliestDate = vi.fn().mockResolvedValue(ANSWER);
  render(
    <CommitActions
      twin={TWIN}
      simulation={HURTS}
      goal={GOAL}
      isCommitting={false}
      planChanged={false}
      onCommit={onCommit}
      onEarliestDate={onEarliestDate}
      {...props}
    />,
  );
  return { onCommit, onEarliestDate, user: userEvent.setup() };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });

describe("CommitActions", () => {
  // CM-1
  it("writes nothing until the reader confirms", async () => {
    const { onCommit, user } = renderActions();
    await user.click(button("Proceed"));
    expect(onCommit).not.toHaveBeenCalled();
    expect(
      screen.getByText("Add Laptop on Sep 20 to your plan? This does not move any money."),
    ).toBeInTheDocument();

    await user.click(button("Yes, save it"));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith([EVENT], undefined);
  });

  it("backs out without writing", async () => {
    const { onCommit, user } = renderActions();
    await user.click(button("Proceed"));
    await user.click(button("Cancel"));
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByText(/does not move any money/)).not.toBeInTheDocument();
  });

  // CM-5 and CM-2
  it("asks the backend for the earliest date before naming one", async () => {
    const { onCommit, onEarliestDate, user } = renderActions();
    await user.click(button(/Sacrifice/));
    expect(onEarliestDate).toHaveBeenCalledExactlyOnceWith(GOAL.id, [EVENT]);
    expect(onCommit).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        `Move ${GOAL.name} from May 1, 2027 to May 31, 2027 and add the purchase?` +
          " The goal is then met in 86% of futures.",
      ),
    ).toBeInTheDocument();
  });

  it("commits the deadline the backend found, with the one it was told", async () => {
    const { onCommit, user } = renderActions();
    await user.click(button(/Sacrifice/));
    await user.click(await screen.findByRole("button", { name: "Yes, save it" }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(
      [EVENT],
      // from_deadline is what the client saw, so a deadline someone else moved
      // in the meantime is a 409 rather than a silent overwrite (CM-4).
      [{ goal_id: GOAL.id, from_deadline: "2027-05-01", deadline: "2027-05-31" }],
    );
  });

  it("says so when no date inside two years restores the goal", async () => {
    const { onCommit, user } = renderActions({
      onEarliestDate: vi.fn().mockResolvedValue({ ...ANSWER, earliest_deadline: null }),
    });
    await user.click(button(/Sacrifice/));
    expect(
      await screen.findByText("No date within 2 years restores this."),
    ).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows the backend's words when the search is refused", async () => {
    const { user } = renderActions({
      onEarliestDate: vi.fn().mockRejectedValue(new Error("Only the earliest goal is eligible")),
    });
    await user.click(button(/Sacrifice/));
    expect(await screen.findByText("Only the earliest goal is eligible")).toBeInTheDocument();
  });

  // CM-5: offered only when the purchase actually costs the goal.
  it("disables Sacrifice when the goal is no worse off", () => {
    renderActions({ simulation: { ...HURTS, counterfactual: HURTS.baseline } });
    expect(button(/Sacrifice/)).toBeDisabled();
  });

  it("hides Sacrifice entirely when there is no goal", () => {
    renderActions({ goal: undefined });
    expect(screen.queryByRole("button", { name: /Sacrifice/ })).not.toBeInTheDocument();
  });

  // SM-12
  it("applies a compromise built from events", async () => {
    const row = compromiseRow();
    const { onCommit, user } = renderActions({ compromise: row });
    await user.click(button("Apply Compromise"));
    await user.click(button("Yes, save it"));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(row.candidate.events, undefined);
  });

  it("shows a spending-cut compromise but will not save it", () => {
    renderActions({
      compromise: compromiseRow({
        spending_adjustments: [{ category: "dining", multiplier: 0.5 }],
      }),
    });
    expect(button("Apply Compromise")).toBeDisabled();
    expect(button("Apply Compromise")).toHaveAttribute(
      "title",
      "Spending cuts can't be saved yet.",
    );
  });

  // CM-6
  it("marks the comparison out of date and stops every button after a commit", () => {
    renderActions({ planChanged: true, compromise: compromiseRow() });
    expect(screen.getByText("Out of date: your plan changed. Simulate again.")).toBeInTheDocument();
    for (const name of ["Proceed", /Sacrifice/, "Apply Compromise"] as const) {
      expect(button(name)).toBeDisabled();
    }
  });

  it("shows the one-line result of a commit", () => {
    renderActions({ commitResult: "Added to your plan." });
    expect(screen.getByText("Added to your plan.")).toBeInTheDocument();
  });

  it("shows a stale-write message where the buttons are", () => {
    renderActions({ commitError: "That changed. Please review and try again." });
    expect(
      screen.getByText("That changed. Please review and try again."),
    ).toBeInTheDocument();
  });

  // G-15
  it("cannot be confirmed twice while the write is in flight", async () => {
    const { user } = renderActions();
    await user.click(button("Proceed"));
    // Re-render in the committing state, as the provider would.
    screen.getByText(/does not move any money/);
    renderActions({ isCommitting: true });
    expect(screen.getAllByRole("button", { name: "Proceed" })[1]).toBeDisabled();
  });

  // E-1
  it("refuses a purchase dated today, which simulates but cannot be planned", () => {
    const today = { ...EVENT, date: TWIN.as_of };
    renderActions({
      simulation: { ...HURTS, request: { ...HURTS.request, events: [today] } },
    });
    expect(button("Proceed")).toBeDisabled();
    expect(button("Proceed")).toHaveAttribute(
      "title",
      "A purchase dated today can't be added to the plan.",
    );
  });

  // G-10
  it("is disabled offline, with the reason in the tooltip", () => {
    renderActions({ isOffline: true });
    expect(button("Proceed")).toHaveAttribute(
      "title",
      "Backend offline. Showing saved sample data. Changes are disabled.",
    );
    expect(button("Proceed")).toBeDisabled();
  });
});
