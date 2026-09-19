import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import mockSimulation from "@/lib/mock/simulation.json";
import type {
  FinancialConstraint,
  Goal,
  OptimizationCandidate,
  OptimizationResponse,
  SimulationResponse,
} from "@/lib/types";
import { AlternativesPanel } from "./AlternativesPanel";

const SIMULATION = mockSimulation as unknown as SimulationResponse;

const RESERVE: FinancialConstraint = {
  id: "con_emergency_reserve",
  type: "minimum_reserve",
  amount: 1500,
  description: "Never fall below $1,500.",
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

function candidate(overrides: Partial<OptimizationCandidate> = {}): OptimizationCandidate {
  return {
    id: "cand_delay",
    kind: "delay",
    label: "Delay to October 15",
    detail: "Waiting four weeks lets one more paycheck land first.",
    events: SIMULATION.request.events,
    spending_adjustments: [],
    metrics: SIMULATION.counterfactual,
    meets_constraints: true,
    violations: [],
    ...overrides,
  };
}

function panel(overrides: Partial<OptimizationResponse> = {}) {
  const optimization: OptimizationResponse = {
    optimization_id: "opt-1",
    user_id: "alex",
    request: { user_id: "alex", events: SIMULATION.request.events },
    horizon_end: SIMULATION.horizon_end,
    baseline: SIMULATION.baseline,
    candidates: [candidate()],
    recommended_id: "cand_delay",
    summary: "Two other ways to make this purchase.",
    assumptions: ["Spending follows the observed averages."],
    num_simulations: 1000,
    ...overrides,
  };
  return render(<AlternativesPanel optimization={optimization} reserve={RESERVE} goal={GOAL} />);
}

describe("AlternativesPanel", () => {
  it("shows the backend's summary and every option it ranked", () => {
    panel({
      candidates: [
        candidate(),
        candidate({ id: "cand_savings", kind: "from_savings", label: "Pay from savings" }),
      ],
    });
    expect(screen.getByText("Two other ways to make this purchase.")).toBeInTheDocument();
    expect(screen.getByText("Delay to October 15")).toBeInTheDocument();
    expect(screen.getByText("Pay from savings")).toBeInTheDocument();
  });

  it("keeps the backend's ranking without calling any option the best", () => {
    panel({
      candidates: [
        candidate({ id: "a", label: "First option" }),
        candidate({ id: "b", label: "Second option" }),
      ],
      recommended_id: "a",
    });
    const labels = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(labels[0]).toContain("First option");
    expect(labels[1]).toContain("Second option");
    expect(screen.queryByText(/Recommended/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bBest\b/i)).not.toBeInTheDocument();
  });

  it("always shows the future without the purchase to compare against", () => {
    panel();
    expect(screen.getByText("Without the purchase")).toBeInTheDocument();
  });

  it("names the declared limits it is scoring against", () => {
    panel();
    expect(screen.getAllByText("Summer housing goal met").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Below the $1,500 reserve").length).toBeGreaterThan(0);
  });

  it("falls back to generic labels when there is no goal or reserve", () => {
    render(
      <AlternativesPanel
        optimization={{
          optimization_id: "opt-1",
          user_id: "alex",
          request: { user_id: "alex", events: SIMULATION.request.events },
          horizon_end: SIMULATION.horizon_end,
          baseline: SIMULATION.baseline,
          candidates: [],
          recommended_id: null,
          summary: "s",
          assumptions: [],
          num_simulations: 1000,
        }}
      />,
    );
    expect(screen.getByText("Goals met")).toBeInTheDocument();
    expect(screen.getByText("Below the reserve")).toBeInTheDocument();
  });

  it("says plainly when an option breaks a declared limit, and why", () => {
    panel({
      candidates: [
        candidate({
          meets_constraints: false,
          violations: ["Falls below the $1,500 emergency reserve in 38% of futures."],
        }),
      ],
    });
    expect(screen.getByText("Breaks a declared limit")).toBeInTheDocument();
    expect(
      screen.getByText("Falls below the $1,500 emergency reserve in 38% of futures."),
    ).toBeInTheDocument();
  });

  it("marks an option that keeps every declared limit", () => {
    panel();
    expect(screen.getByText("Keeps your declared limits")).toBeInTheDocument();
  });

  it("still renders its summary and assumptions when nothing was found", () => {
    panel({ candidates: [], summary: "No lower-impact alternative was found." });
    expect(screen.getByText("No lower-impact alternative was found.")).toBeInTheDocument();
    expect(screen.getByText("Spending follows the observed averages.")).toBeInTheDocument();
  });

  it("says how many futures each option was scored on", () => {
    panel({ num_simulations: 2000 });
    expect(screen.getByText(/2,000 simulated futures per option/)).toBeInTheDocument();
  });

  it("reads a goal with no probability as a shortfall instead", () => {
    panel({
      candidates: [
        candidate({
          metrics: { ...SIMULATION.counterfactual, prob_goal_met: null, goal_shortfall: 450 },
        }),
      ],
    });
    const option = screen.getByText("Delay to October 15").closest("li")!;
    expect(within(option).getByText("$450 short")).toBeInTheDocument();
  });
});
