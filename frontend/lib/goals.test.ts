import { describe, expect, it } from "vitest";

import { describeChange, mergeConstraints, mergeGoals, removeGoal, withoutGoal } from "./goals";
import type { FinancialConstraint, FinancialTwin, Goal } from "./types";

function goal(id: string, name: string, target: number, deadline: string, current = 0): Goal {
  return {
    id,
    name,
    target_amount: target,
    deadline,
    current_amount: current,
    provenance: "declared",
  };
}

function constraint(
  type: FinancialConstraint["type"],
  amount: number,
  description: string,
): FinancialConstraint {
  return { id: `constraint_${type}`, type, amount, description, provenance: "declared" };
}

/** Alex's declared set, as the twin holds it before any new goal is typed. */
const housing = goal("goal_summer_housing", "Summer housing", 2000, "2027-05-01", 450);
const reserve = constraint("minimum_reserve", 1500, "Keep at least $1,500 for emergencies");

describe("mergeGoals", () => {
  it("returns the existing goals when there is nothing to merge", () => {
    const existing = [housing];
    expect(mergeGoals(existing, [])).toEqual(existing);
  });

  it("appends a goal with an unseen id after the existing ones", () => {
    const laptop = goal("goal_laptop", "Laptop", 800, "2026-12-01");
    const merged = mergeGoals([housing], [laptop]);
    expect(merged.map((g) => g.id)).toEqual(["goal_summer_housing", "goal_laptop"]);
  });

  it("appends several new goals in draft order", () => {
    const laptop = goal("goal_laptop", "Laptop", 800, "2026-12-01");
    const bike = goal("goal_bike", "Bike", 300, "2027-03-01");
    expect(mergeGoals([housing], [laptop, bike]).map((g) => g.id)).toEqual([
      "goal_summer_housing",
      "goal_laptop",
      "goal_bike",
    ]);
  });

  it("replaces a same-id goal in place, keeping its position and taking the draft's fields", () => {
    // The compiler slugs the name, so retyping a goal yields the same id.
    const laptop = goal("goal_laptop", "Laptop", 800, "2026-12-01");
    const redrafted = goal("goal_summer_housing", "Summer housing", 2500, "2027-06-01");
    const merged = mergeGoals([housing, laptop], [redrafted]);
    expect(merged.map((g) => g.id)).toEqual(["goal_summer_housing", "goal_laptop"]);
    expect(merged[0].name).toBe("Summer housing");
    expect(merged[0].target_amount).toBe(2500);
    expect(merged[0].deadline).toBe("2027-06-01");
  });

  it("keeps the saved progress when a draft replaces a goal", () => {
    // The compiler always emits current_amount 0; $450 is real progress.
    const redrafted = goal("goal_summer_housing", "Summer housing", 2500, "2027-06-01");
    expect(redrafted.current_amount).toBe(0);
    expect(mergeGoals([housing], [redrafted])[0].current_amount).toBe(450);
  });

  it("produces unique ids even if two drafts share one, the later winning", () => {
    const first = goal("goal_laptop", "Laptop", 800, "2026-12-01");
    const second = goal("goal_laptop", "Laptop", 950, "2027-01-01");
    const merged = mergeGoals([housing], [first, second]);
    expect(new Set(merged.map((g) => g.id)).size).toBe(merged.length);
    expect(merged.find((g) => g.id === "goal_laptop")?.target_amount).toBe(950);
  });

  it("does not mutate either input array", () => {
    const existing = [housing];
    const drafts = [
      goal("goal_summer_housing", "Summer housing", 2500, "2027-06-01"),
      goal("goal_laptop", "Laptop", 800, "2026-12-01"),
    ];
    const existingCopy = structuredClone(existing);
    const draftsCopy = structuredClone(drafts);
    mergeGoals(existing, drafts);
    expect(existing).toEqual(existingCopy);
    expect(drafts).toEqual(draftsCopy);
  });
});

describe("mergeConstraints", () => {
  it("keeps the emergency reserve alive when the drafts say nothing about it", () => {
    // Without this, saving one new goal would wipe out Alex's $1,500 reserve.
    const merged = mergeConstraints([reserve], []);
    expect(merged).toEqual([reserve]);
  });

  it("lets a drafted reserve override the existing one", () => {
    const raised = constraint("minimum_reserve", 2000, "Keep at least $2,000 for emergencies");
    const merged = mergeConstraints([reserve], [raised]);
    expect(merged).toHaveLength(1);
    expect(merged[0].amount).toBe(2000);
    expect(merged[0].description).toBe("Keep at least $2,000 for emergencies");
  });

  it("adds a drafted checking floor alongside the existing reserve", () => {
    const floor = constraint("minimum_checking_balance", 300, "Keep $300 in checking");
    const merged = mergeConstraints([reserve], [floor]);
    expect(merged.map((c) => c.type)).toEqual(["minimum_reserve", "minimum_checking_balance"]);
  });

  it("keeps one constraint per type when both lists carry both types", () => {
    const floor = constraint("minimum_checking_balance", 300, "Keep $300 in checking");
    const merged = mergeConstraints(
      [reserve, floor],
      [
        constraint("minimum_reserve", 2000, "Raised reserve"),
        constraint("minimum_checking_balance", 500, "Raised floor"),
      ],
    );
    expect(merged.map((c) => c.type)).toEqual(["minimum_reserve", "minimum_checking_balance"]);
    expect(merged.map((c) => c.amount)).toEqual([2000, 500]);
  });

  it("does not mutate either input array", () => {
    const existing = [reserve];
    const drafts = [constraint("minimum_reserve", 2000, "Raised reserve")];
    const existingCopy = structuredClone(existing);
    const draftsCopy = structuredClone(drafts);
    mergeConstraints(existing, drafts);
    expect(existing).toEqual(existingCopy);
    expect(drafts).toEqual(draftsCopy);
  });
});

describe("describeChange", () => {
  it("labels new, updated and unchanged goals across one merged set", () => {
    const untouched = goal("goal_bike", "Bike", 300, "2027-03-01", 75);
    const existing = [housing, untouched];
    const merged = mergeGoals(existing, [
      goal("goal_summer_housing", "Summer housing", 2500, "2027-06-01"),
      goal("goal_laptop", "Laptop", 800, "2026-12-01"),
    ]);

    const changes = describeChange(existing, merged);
    expect(changes.get("goal_summer_housing")).toBe("updated");
    expect(changes.get("goal_bike")).toBe("unchanged");
    expect(changes.get("goal_laptop")).toBe("new");
    expect(changes.size).toBe(3);
  });

  it("calls a goal unchanged when the fields match but the object does not", () => {
    // A merged goal is always a fresh object, so identity must not decide this.
    const merged = mergeGoals([housing], [structuredClone(housing)]);
    expect(merged[0]).not.toBe(housing);
    expect(describeChange([housing], merged).get("goal_summer_housing")).toBe("unchanged");
  });

  it("calls a goal updated when only the deadline moves", () => {
    const merged = mergeGoals([housing], [{ ...housing, deadline: "2027-06-01" }]);
    expect(describeChange([housing], merged).get("goal_summer_housing")).toBe("updated");
  });

  it("describes nothing for an empty merged set", () => {
    expect(describeChange([housing], []).size).toBe(0);
  });
});

describe("removeGoal", () => {
  const laptop = goal("goal_laptop", "Laptop", 800, "2026-12-01");

  it("drops only the goal with that id, keeping the others in order", () => {
    const trip = goal("goal_trip", "Trip", 500, "2027-03-01");
    expect(removeGoal([housing, laptop, trip], "goal_laptop")).toEqual([housing, trip]);
  });

  it("can remove the last goal", () => {
    expect(removeGoal([housing], "goal_summer_housing")).toEqual([]);
  });

  it("removes nothing for an unknown id", () => {
    expect(removeGoal([housing, laptop], "goal_missing")).toEqual([housing, laptop]);
  });
});

describe("withoutGoal", () => {
  const minimum = constraint("minimum_checking_balance", 300, "Keep at least $300 in checking");
  const twin = {
    goals: [housing, goal("goal_laptop", "Laptop", 800, "2026-12-01")],
    constraints: [reserve, minimum],
  } as FinancialTwin;

  it("sends every other goal and every constraint, so the reserve survives", () => {
    expect(withoutGoal(twin, "goal_laptop")).toEqual({
      goals: [housing],
      constraints: [reserve, minimum],
    });
  });
});
