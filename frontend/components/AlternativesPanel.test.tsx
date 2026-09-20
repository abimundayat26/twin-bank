import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import mockSimulation from "@/lib/mock/simulation.json";
import type {
  OptimizationCandidate,
  OptimizationResponse,
  SimulationResponse,
} from "@/lib/types";
import { AlternativesPanel } from "./AlternativesPanel";

const SIMULATION = mockSimulation as unknown as SimulationResponse;

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

const BUY_NOW = candidate({
  id: "cand_buy_now",
  kind: "buy_now",
  detail: "The purchase as entered.",
});

function panel(overrides: Partial<OptimizationResponse> = {}) {
  const optimization: OptimizationResponse = {
    optimization_id: "opt-1",
    user_id: "alex",
    request: { user_id: "alex", events: SIMULATION.request.events },
    horizon_end: SIMULATION.horizon_end,
    baseline: SIMULATION.baseline,
    candidates: [BUY_NOW, candidate()],
    recommended_id: "cand_delay",
    summary: "Other ways to make this purchase.",
    assumptions: ["Spending follows the observed averages."],
    num_simulations: 1000,
    ...overrides,
  };
  render(
    <AlternativesPanel
      optimization={optimization}
      purchaseMetrics={{ ...SIMULATION.counterfactual, ending_balance: 2596 }}
    />,
  );
}

const rowFor = (label: string) => screen.getByRole("rowheader", { name: new RegExp(label) }).closest("tr")!;

describe("AlternativesPanel", () => {
  // SM-11
  it("lays out the four value columns plus the limits one", () => {
    panel();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual([
      "Option",
      "Predicted balance",
      "Chance of low balance",
      "Chance goal is met",
      "Keeps your limits",
    ]);
  });

  it("shows each row's own figures, with the simulate numbers on Buy as planned", () => {
    panel();
    expect(within(rowFor("Buy as planned")).getByText("$2,596")).toBeInTheDocument();
  });

  it("names the first broken limit rather than only saying no", () => {
    panel({
      candidates: [
        BUY_NOW,
        candidate({
          meets_constraints: false,
          violations: ["Dips below the $1,500 reserve", "Misses Summer housing"],
        }),
      ],
    });
    const row = rowFor("Best alternative");
    expect(within(row).getByText("No")).toBeInTheDocument();
    expect(within(row).getByText("Dips below the $1,500 reserve")).toBeInTheDocument();
    expect(within(row).queryByText("Misses Summer housing")).not.toBeInTheDocument();
  });

  it("marks an option that keeps every limit", () => {
    panel();
    expect(within(rowFor("Best alternative")).getByText("Yes")).toBeInTheDocument();
  });

  // E-5: a candidate the backend could not score shows a dash, not a zero.
  it("dashes a goal chance that was never computed", () => {
    panel({
      candidates: [
        BUY_NOW,
        candidate({ metrics: { ...SIMULATION.counterfactual, prob_goal_met: null } }),
      ],
    });
    const cells = within(rowFor("Best alternative")).getAllByRole("cell");
    expect(cells[2]).toHaveTextContent("-");
  });

  // G-8
  it("says the optimizer found nothing rather than showing an empty table", () => {
    panel({ candidates: [], recommended_id: null });
    expect(
      screen.getByText("No other way to make this purchase was found."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
