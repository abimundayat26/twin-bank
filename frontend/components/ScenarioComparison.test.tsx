import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import mockSimulation from "@/lib/mock/simulation.json";
import mockTwin from "@/lib/mock/twin.json";
import type {
  FinancialTwin,
  ImpactAssessment,
  ScenarioMetrics,
  SimulationResponse,
} from "@/lib/types";
import { ScenarioComparison } from "./ScenarioComparison";

const SIMULATION = mockSimulation as unknown as SimulationResponse;
const TWIN = mockTwin as unknown as FinancialTwin;

/** Section 7.4: Alex's seeded baseline. */
const BASE: ScenarioMetrics = {
  ending_balance: 3396,
  min_balance: 2508,
  prob_low_balance: 0.015,
  prob_below_reserve: 0,
  goal_shortfall: 0,
  obligations_covered: true,
  prob_obligations_uncovered: 0,
  prob_goal_met: 0.768,
  prob_savings_sweep: 0,
};

function withMetrics(
  baseline: Partial<ScenarioMetrics>,
  counterfactual: Partial<ScenarioMetrics>,
  simulation: Partial<SimulationResponse> = {},
  twin: Partial<FinancialTwin> = {},
) {
  return render(
    <ScenarioComparison
      twin={{ ...TWIN, ...twin }}
      simulation={{
        ...SIMULATION,
        baseline: { ...BASE, ...baseline },
        counterfactual: { ...BASE, ...counterfactual },
        ...simulation,
      }}
    />,
  );
}

/** A metric row, so a value is read against the row it belongs to. */
function row(label: string): HTMLElement {
  return screen.getByText(label).parentElement as HTMLElement;
}

/** [No Purchase, Purchase] for one row, in that order. */
function cells(label: string): HTMLElement[] {
  const labelCell = screen.getByText(label);
  const siblings = Array.from(labelCell.parentElement!.children) as HTMLElement[];
  return siblings.slice(siblings.indexOf(labelCell) + 1, siblings.indexOf(labelCell) + 3);
}

describe("ScenarioComparison", () => {
  // SM-4
  it("heads the two columns and names the purchase under the second", () => {
    withMetrics({}, {});
    expect(screen.getByText("No Purchase")).toBeInTheDocument();
    expect(screen.getByText("Purchase")).toBeInTheDocument();
    expect(screen.getByText("Laptop · $800")).toBeInTheDocument();
  });

  // SM-4 with G-1: the horizon is in a later year than as_of, so it keeps it.
  it("says what period every number covers", () => {
    withMetrics({}, {});
    expect(screen.getByText("Through May 1, 2027")).toBeInTheDocument();
  });

  it("lists exactly the rows of section 7.1, in order", () => {
    withMetrics({}, {});
    const labels = [
      "Predicted balance",
      "Chance of low balance",
      "Chance of dipping into your reserve",
      "Chance of paying a bill out of savings",
      "Chance your goal is met",
      "Upcoming bills",
    ];
    for (const label of labels) expect(screen.getByText(label)).toBeInTheDocument();
    // Nothing from the old layout survives: SM-6 removed the narrative rows.
    expect(screen.queryByText(/Lowest balance/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pts/)).not.toBeInTheDocument();
  });

  it("shows whole dollars and whole percentages", () => {
    withMetrics({}, { ending_balance: 2596.4, prob_low_balance: 0.966 });
    expect(screen.getByText("$3,396")).toBeInTheDocument();
    expect(screen.getByText("$2,596")).toBeInTheDocument();
    expect(screen.getByText("97%")).toBeInTheDocument();
  });

  // G-3
  it("never rounds a small but real risk down to zero", () => {
    withMetrics({ prob_below_reserve: 0 }, { prob_below_reserve: 0.002 });
    expect(row("Chance of dipping into your reserve")).toHaveTextContent("<1%");
  });

  // E-5
  it("shows a figure the backend did not compute as a dash", () => {
    withMetrics({ prob_savings_sweep: null }, { prob_savings_sweep: null });
    const [before, after] = cells("Chance of paying a bill out of savings");
    expect(before).toHaveTextContent("-");
    expect(after).toHaveTextContent("-");
  });

  // 7.1: bold reads the unrounded value (G-4).
  it("bolds a probability at even odds or worse", () => {
    withMetrics({ prob_low_balance: 0.49 }, { prob_low_balance: 0.5 });
    const [before, after] = cells("Chance of low balance");
    expect(within(before).getByText("49%")).not.toHaveClass("font-bold");
    expect(within(after).getByText("50%")).toHaveClass("font-bold");
  });

  it("bolds the goal once the purchase costs a quarter of its chance", () => {
    // 0.768 - 0.518 is exactly the 0.25 the row is bold at.
    withMetrics({}, { prob_goal_met: 0.518 });
    expect(within(cells("Chance your goal is met")[1]).getByText("52%")).toHaveClass("font-bold");
  });

  it("leaves the goal unbolded a thousandth under that", () => {
    withMetrics({}, { prob_goal_met: 0.519 });
    // Both columns round to a printable percentage; the threshold reads the
    // unrounded values (G-4), so 52% here and 52% above differ in weight.
    expect(within(cells("Chance your goal is met")[1]).getByText("52%")).not.toHaveClass(
      "font-bold",
    );
  });

  it("adds the shortfall under the chance when the goal comes up short", () => {
    withMetrics({}, { goal_shortfall: 504 });
    expect(screen.getByText("Short by $504")).toBeInTheDocument();
  });

  it("asks about every goal when the twin has more than one", () => {
    withMetrics({}, {}, {}, { goals: [...TWIN.goals, { ...TWIN.goals[0], id: "goal_two" }] });
    expect(screen.getByText("Chance every goal is met")).toBeInTheDocument();
  });

  // E-4
  it("hides the reserve row for a twin that declared no reserve", () => {
    const constraints = TWIN.constraints.filter((c) => c.type !== "minimum_reserve");
    withMetrics({}, {}, {}, { constraints });
    expect(screen.queryByText("Chance of dipping into your reserve")).not.toBeInTheDocument();
  });

  it("hides the goal row when there is no goal, and when none was scored", () => {
    withMetrics({}, {}, {}, { goals: [] });
    expect(screen.queryByText(/goal is met/)).not.toBeInTheDocument();

    withMetrics({ prob_goal_met: null }, { prob_goal_met: null });
    expect(screen.queryByText(/goal is met/)).not.toBeInTheDocument();
  });

  // 7.2
  it("reads the bills badge from the Monte Carlo share, not the covered flag", () => {
    withMetrics(
      { prob_obligations_uncovered: 0 },
      // The $2,500 case: covered on the expected path, uncovered in 37% of futures.
      { prob_obligations_uncovered: 0.367, obligations_covered: true },
    );
    const [before, after] = cells("Upcoming bills");
    expect(before).toHaveTextContent("Covered");
    expect(after).toHaveTextContent("At risk");
  });

  it("calls a bill not covered once most futures miss it", () => {
    withMetrics({}, { prob_obligations_uncovered: 0.5 });
    expect(cells("Upcoming bills")[1]).toHaveTextContent("Not covered");
  });

  it("falls back to the covered flag only when the share is missing", () => {
    withMetrics(
      { prob_obligations_uncovered: null },
      { prob_obligations_uncovered: null, obligations_covered: false },
    );
    const [before, after] = cells("Upcoming bills");
    expect(before).toHaveTextContent("Covered");
    expect(after).toHaveTextContent("Not covered");
  });

  // SM-5
  it("shows the impact level with its reasons in the accessible name", () => {
    const impact: ImpactAssessment = {
      level: "high",
      reasons: ["Chance of low balance rises by 95 points", "Goal is short by $504 more"],
    };
    withMetrics({}, {}, { impact });
    const badge = screen.getByLabelText(
      "High impact: Chance of low balance rises by 95 points, Goal is short by $504 more",
    );
    expect(badge).toHaveTextContent("High impact");
  });

  // E-5: a level the backend did not send is not one the page may infer.
  it("omits the impact badge when the result carries none", () => {
    withMetrics({}, {}, { impact: null });
    expect(screen.queryByText(/impact/i)).not.toBeInTheDocument();
  });

  // G-13 / SM-7
  it("tags sample figures, and does not when the result is live", () => {
    withMetrics({}, {}, { is_mock: true });
    expect(screen.getByText("Sample figures")).toBeInTheDocument();

    withMetrics({}, {}, { is_mock: false });
    expect(screen.getAllByText("Sample figures")).toHaveLength(1);
  });
});
