import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import mockSimulation from "@/lib/mock/simulation.json";
import type {
  FinancialConstraint,
  Goal,
  ScenarioMetrics,
  SimulationResponse,
} from "@/lib/types";
import { ScenarioComparison } from "./ScenarioComparison";

const SIMULATION = mockSimulation as unknown as SimulationResponse;

const RESERVE: FinancialConstraint = {
  id: "con_emergency_reserve",
  type: "minimum_reserve",
  amount: 1500,
  description: "Never let checking plus savings fall below $1,500.",
  provenance: "declared",
};

const GOAL: Goal = {
  id: "goal_summer_housing",
  name: "Summer housing",
  target_amount: 1600,
  deadline: "2027-05-01",
  current_amount: 0,
  provenance: "declared",
};

const BASE: ScenarioMetrics = {
  ending_balance: 3280.51,
  min_balance: 2472.14,
  prob_low_balance: 0.06,
  prob_below_reserve: 0.002,
  goal_shortfall: 0,
  obligations_covered: true,
  prob_obligations_uncovered: 0,
  prob_goal_met: 0.649,
  prob_savings_sweep: 0.007,
};

function withMetrics(
  baseline: Partial<ScenarioMetrics>,
  counterfactual: Partial<ScenarioMetrics>,
  simulation: Partial<SimulationResponse> = {},
) {
  return render(
    <ScenarioComparison
      simulation={{
        ...SIMULATION,
        baseline: { ...BASE, ...baseline },
        counterfactual: { ...BASE, ...counterfactual },
        ...simulation,
      }}
      reserve={RESERVE}
      goal={GOAL}
    />,
  );
}

/** The row's cells, so a value can be checked against the metric it belongs to. */
function row(label: string): HTMLElement {
  const cell = screen.getByText(label).closest("div");
  return cell!.parentElement as HTMLElement;
}

describe("ScenarioComparison", () => {
  it("labels the two futures and names the purchase behind the counterfactual", () => {
    withMetrics({}, {});
    expect(screen.getByText("Baseline")).toBeInTheDocument();
    expect(screen.getByText("No purchase")).toBeInTheDocument();
    expect(screen.getByText("Counterfactual")).toBeInTheDocument();
    expect(screen.getByText("Laptop · $800")).toBeInTheDocument();
  });

  it("calls balances medians only when the result came from simulated futures", () => {
    withMetrics({}, {});
    expect(screen.getByText("Median ending balance")).toBeInTheDocument();
    expect(
      screen.getByText("At the end of the horizon, across 1,000 simulated futures"),
    ).toBeInTheDocument();
  });

  it("drops the median wording on a result with no simulation count", () => {
    withMetrics({}, {}, { num_simulations: null });
    expect(screen.getByText("Ending balance")).toBeInTheDocument();
    expect(screen.getByText("At the end of the horizon")).toBeInTheDocument();
    expect(screen.queryByText("Median ending balance")).not.toBeInTheDocument();
  });

  it("shows the counterfactual's shortfall as a signed difference", () => {
    withMetrics({ ending_balance: 3280.51 }, { ending_balance: 2480.51 });
    expect(screen.getByText("−$800")).toBeInTheDocument();
  });

  it("shows a gain with a plus sign rather than a bare number", () => {
    withMetrics({ ending_balance: 3000 }, { ending_balance: 3200 });
    expect(screen.getByText("+$200")).toBeInTheDocument();
  });

  it("writes an unchanged metric as +$0, never as a blank cell", () => {
    withMetrics({ ending_balance: 3000 }, { ending_balance: 3000 });
    expect(screen.getAllByText("+$0").length).toBeGreaterThan(0);
  });

  it("reports probability changes in points, not as a second percentage", () => {
    withMetrics({ prob_low_balance: 0.06 }, { prob_low_balance: 0.65 });
    expect(screen.getByText("+59 pts")).toBeInTheDocument();
  });

  // chance() exists so a rare risk is never rounded away to 0%.
  it("never rounds a small but real risk down to zero", () => {
    withMetrics({ prob_below_reserve: 0 }, { prob_below_reserve: 0.002 });
    const cells = row("Chance of dipping into the emergency reserve");
    expect(cells).toHaveTextContent("<1%");
  });

  it("reads the goal from simulated futures when the backend scored it", () => {
    withMetrics({ prob_goal_met: 0.649 }, { prob_goal_met: 0.41 });
    expect(screen.getByText("Met in 65% of futures")).toBeInTheDocument();
    expect(screen.getByText("Met in 41% of futures")).toBeInTheDocument();
    expect(screen.getByText("-24 pts")).toBeInTheDocument();
  });

  it("falls back to the shortfall when no goal probability was computed", () => {
    withMetrics(
      { prob_goal_met: null, goal_shortfall: 0 },
      { prob_goal_met: null, goal_shortfall: 320 },
    );
    expect(screen.getByText("On track")).toBeInTheDocument();
    expect(screen.getByText("$320 short")).toBeInTheDocument();
  });

  // A goal whose deadline is past the horizon was never simulated, so calling it
  // "on track" would be a claim the simulation never made.
  it("says a goal past the horizon was not evaluated instead of calling it on track", () => {
    withMetrics(
      { prob_goal_met: null, goal_shortfall: 0 },
      { prob_goal_met: null, goal_shortfall: 0 },
      { horizon_end: "2026-12-31" },
    );
    expect(
      screen.getAllByText("Not evaluated (deadline after horizon)").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("On track")).not.toBeInTheDocument();
  });

  it("names the goal it is scoring rather than saying 'savings goal'", () => {
    withMetrics({}, {});
    expect(screen.getByText("Summer housing goal")).toBeInTheDocument();
    expect(screen.getByText("$1,600 by May 1, 2027")).toBeInTheDocument();
  });

  it("falls back to a generic label when the twin has no goal", () => {
    render(<ScenarioComparison simulation={SIMULATION} reserve={RESERVE} />);
    expect(screen.getByText("Savings goal")).toBeInTheDocument();
  });

  it("says how often obligations were covered, not merely that they were", () => {
    withMetrics({ prob_obligations_uncovered: 0 }, { prob_obligations_uncovered: 0.12 });
    expect(screen.getByText("Yes · covered in every future")).toBeInTheDocument();
    expect(screen.getByText("Yes · covered in 88% of futures")).toBeInTheDocument();
  });

  it("gives a bare yes or no when the backend did not report the share", () => {
    withMetrics(
      { prob_obligations_uncovered: null },
      { prob_obligations_uncovered: null, obligations_covered: false },
    );
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("marks a newly uncovered bill as worse even though it has no delta", () => {
    withMetrics(
      { prob_obligations_uncovered: null, obligations_covered: true },
      { prob_obligations_uncovered: null, obligations_covered: false },
    );
    expect(screen.getByText("Worse")).toBeInTheDocument();
  });

  it("distinguishes a bill paid out of savings from one not paid at all", () => {
    withMetrics({ prob_savings_sweep: 0 }, { prob_savings_sweep: 0.23 });
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(screen.getByText("In 23% of futures")).toBeInTheDocument();
  });

  it("admits when the savings sweep was not calculated rather than showing 0%", () => {
    withMetrics({ prob_savings_sweep: null }, { prob_savings_sweep: null });
    expect(screen.getAllByText("Not calculated")).toHaveLength(2);
  });

  it("carries the reserve's own words into the row about it", () => {
    withMetrics({}, {});
    expect(screen.getByText(RESERVE.description)).toBeInTheDocument();
    expect(screen.getByText("Emergency reserve is $1,500")).toBeInTheDocument();
  });

  it("drops the reserve captions entirely when none is declared", () => {
    render(<ScenarioComparison simulation={SIMULATION} goal={GOAL} />);
    expect(screen.queryByText(/Emergency reserve is/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Chance of dipping into the emergency reserve"),
    ).toBeInTheDocument();
  });

  // SPEC 7.1 names long purchase names. This is the narrowest of the three
  // columns, so it is where a long one clips first.
  it("wraps a long purchase name in the counterfactual column", () => {
    const description = "Refurbished 16-inch developer laptop with extended warranty";
    const simulation = {
      ...SIMULATION,
      request: {
        ...SIMULATION.request,
        events: [{ ...SIMULATION.request.events[0], description }],
      },
    } as SimulationResponse;
    render(<ScenarioComparison simulation={simulation} goal={GOAL} />);
    const caption = screen.getByText(new RegExp(description));
    expect(caption).not.toHaveClass("truncate");
    expect(caption).toHaveClass("break-words");
  });
});
