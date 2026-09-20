/**
 * The Overview's read-only summaries. SPEC 3.1 keeps the editing surfaces off
 * this page, so these tests check what is *absent* as much as what is shown.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import mockTwin from "@/lib/mock/twin.json";
import type { FinancialTwin, Goal } from "@/lib/types";
import { GoalsSummary, ObligationsSummary } from "./PlanSummary";

const TWIN = mockTwin as unknown as FinancialTwin;
const twinWith = (overrides: Partial<FinancialTwin>): FinancialTwin => ({
  ...TWIN,
  ...overrides,
});

function goal(overrides: Partial<Goal>): Goal {
  return {
    id: "goal_a",
    name: "Goal A",
    target_amount: 1000,
    deadline: "2027-01-01",
    current_amount: 0,
    provenance: "declared",
    ...overrides,
  };
}

describe("GoalsSummary", () => {
  it("counts one goal in the singular", () => {
    render(<GoalsSummary twin={TWIN} />);
    expect(screen.getByText("1 active goal")).toBeInTheDocument();
  });

  it("counts several goals in the plural", () => {
    render(
      <GoalsSummary
        twin={twinWith({ goals: [goal({ id: "a" }), goal({ id: "b", name: "Goal B" })] })}
      />,
    );
    expect(screen.getByText("2 active goals")).toBeInTheDocument();
  });

  // The earliest deadline is where the default simulation horizon ends, so it
  // has to come first.
  it("puts the soonest deadline first, whatever order the twin listed them in", () => {
    render(
      <GoalsSummary
        twin={twinWith({
          goals: [
            goal({ id: "later", name: "Later goal", deadline: "2027-12-01" }),
            goal({ id: "sooner", name: "Sooner goal", deadline: "2027-02-01" }),
          ],
        })}
      />,
    );
    const names = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(names[0]).toContain("Sooner goal");
    expect(names[1]).toContain("Later goal");
  });

  it("says what a twin with no goals means for the horizon", () => {
    render(<GoalsSummary twin={twinWith({ goals: [] })} />);
    expect(screen.getByText(/No goals declared/)).toBeInTheDocument();
    expect(screen.getByText("0 active goals")).toBeInTheDocument();
  });

  it("points at Plans rather than embedding the composer", () => {
    render(<GoalsSummary twin={TWIN} />);
    expect(screen.getByRole("link", { name: "Add or change a goal" })).toHaveAttribute(
      "href",
      "/plans",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("marks each goal as declared, never as observed", () => {
    render(<GoalsSummary twin={TWIN} />);
    expect(screen.getByText("You declared")).toBeInTheDocument();
  });
});

describe("ObligationsSummary", () => {
  it("counts the mandatory and recurring obligations separately", () => {
    render(<ObligationsSummary twin={TWIN} />);
    expect(screen.getByText("3 mandatory · 2 recurring")).toBeInTheDocument();
  });

  it("surfaces the bill due soonest in the month", () => {
    render(<ObligationsSummary twin={TWIN} />);
    const row = screen.getByText("The next mandatory bill").closest("li")!;
    expect(within(row).getByText("Hokie Property Mgmt Rent")).toBeInTheDocument();
  });

  it("says so plainly when nothing is mandatory", () => {
    render(<ObligationsSummary twin={twinWith({ obligations: [] })} />);
    expect(screen.getByText("No mandatory bills detected.")).toBeInTheDocument();
    expect(screen.getByText("0 mandatory · 0 recurring")).toBeInTheDocument();
  });

  it("counts an open question and sends it to Plans to be answered", () => {
    render(<ObligationsSummary twin={TWIN} />);
    expect(screen.getByText("1 question")).toBeInTheDocument();
    expect(screen.getByText(/could not classify a bill/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Answer in Plans/ })).toHaveAttribute(
      "href",
      "/plans",
    );
  });

  it("pluralises several open questions", () => {
    const twoQuestions = TWIN.obligations.map((o) =>
      o.id === "obl_spotify_premium"
        ? { ...o, category_candidates: [{ category: "bill" as const, probability: 0.5 }] }
        : o,
    );
    render(<ObligationsSummary twin={twinWith({ obligations: twoQuestions })} />);
    expect(screen.getByText("2 questions")).toBeInTheDocument();
    expect(screen.getByText(/could not classify some bills/)).toBeInTheDocument();
  });

  it("offers a plain review link when nothing is open", () => {
    const answered = TWIN.obligations.map((o) => ({ ...o, category_candidates: [] }));
    render(<ObligationsSummary twin={twinWith({ obligations: answered })} />);
    expect(screen.queryByText(/question/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review obligations" })).toHaveAttribute(
      "href",
      "/plans",
    );
  });

  it("asks no question on this page, only links to where it is asked", () => {
    render(<ObligationsSummary twin={TWIN} />);
    expect(screen.queryByText("What is this?")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
