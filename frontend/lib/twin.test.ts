import { describe, expect, it } from "vitest";

import { byDeadline, emergencyReserve, primaryGoal } from "./twin";
import type { FinancialConstraint, FinancialTwin, Goal } from "./types";

function goal(id: string, deadline: string): Goal {
  return {
    id,
    name: id,
    target_amount: 2000,
    current_amount: 0,
    deadline,
    provenance: "declared",
  };
}

function twinWith(goals: Goal[], constraints: FinancialConstraint[] = []): FinancialTwin {
  return { goals, constraints } as FinancialTwin;
}

describe("byDeadline", () => {
  it("puts the soonest deadline first", () => {
    const sorted = byDeadline([goal("b", "2027-05-01"), goal("a", "2026-12-01")]);
    expect(sorted.map((g) => g.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the twin's own array", () => {
    const goals = [goal("b", "2027-05-01"), goal("a", "2026-12-01")];
    byDeadline(goals);
    expect(goals.map((g) => g.id)).toEqual(["b", "a"]);
  });
});

describe("primaryGoal", () => {
  it("is the goal that sets the horizon", () => {
    const twin = twinWith([goal("b", "2027-05-01"), goal("a", "2026-12-01")]);
    expect(primaryGoal(twin)?.id).toBe("a");
  });

  it("is undefined when nothing is declared", () => {
    expect(primaryGoal(twinWith([]))).toBeUndefined();
  });
});

describe("emergencyReserve", () => {
  it("finds the reserve and ignores other constraints", () => {
    const twin = twinWith(
      [],
      [
        { id: "m", type: "minimum_checking_balance", amount: 200 } as FinancialConstraint,
        { id: "r", type: "minimum_reserve", amount: 1500 } as FinancialConstraint,
      ],
    );
    expect(emergencyReserve(twin)?.amount).toBe(1500);
  });

  it("is undefined when no reserve was declared", () => {
    expect(emergencyReserve(twinWith([]))).toBeUndefined();
  });
});
