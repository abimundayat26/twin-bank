import { describe, expect, it } from "vitest";

import {
  appendAnswers,
  answerSentence,
  applyEdits,
  describeChange,
  isEditValid,
  mergeConstraints,
  mergeGoals,
  removeGoal,
  validateEdit,
  withoutGoal,
} from "./goals";
import type {
  FinancialConstraint,
  FinancialTwin,
  Goal,
  GoalClarification,
  GoalClarificationField,
} from "./types";

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

function clarification(
  field: GoalClarificationField,
  question: string,
  fragment: string,
): GoalClarification {
  return { field, question, fragment };
}

describe("answerSentence", () => {
  it("puts an amount before the 'for' phrase, where the compiler reads it", () => {
    const asked = clarification("amount", "How much?", "I want to save for a trip");
    expect(answerSentence(asked, "2000")).toBe("I want to save $2000 for a trip");
  });

  it("leaves an amount the user already wrote as money alone", () => {
    const asked = clarification("amount", "How much?", "I want to save for a trip");
    expect(answerSentence(asked, "$2,000")).toBe("I want to save $2,000 for a trip");
  });

  it("appends an amount when there is no 'for' phrase to sit before", () => {
    const asked = clarification("amount", "How much?", "save up");
    expect(answerSentence(asked, "800")).toBe("save up $800");
  });

  it("adds 'by' to a date that does not say it", () => {
    const asked = clarification("deadline", "By when?", "I need $800 for a laptop");
    expect(answerSentence(asked, "2026-12-01")).toBe("I need $800 for a laptop by 2026-12-01");
  });

  it("does not double a 'by' or an 'in' the user typed", () => {
    const asked = clarification("deadline", "By when?", "save $800 for a laptop");
    expect(answerSentence(asked, "by May 1")).toBe("save $800 for a laptop by May 1");
    expect(answerSentence(asked, "in 6 months")).toBe("save $800 for a laptop in 6 months");
  });

  it("adds 'from' to a funding account that does not say it", () => {
    const asked = clarification("account", "Which account?", "I have $1,200 tuition due 2027-01-15");
    expect(answerSentence(asked, "checking")).toBe(
      "I have $1,200 tuition due 2027-01-15 from checking",
    );
    expect(answerSentence(asked, "from checking")).toBe(
      "I have $1,200 tuition due 2027-01-15 from checking",
    );
  });

  it("replaces the fragment when the question is which reading was meant", () => {
    // "intent" and "type" both ask the user to choose, so only their own words settle it.
    const asked = clarification("intent", "Saving toward, or already owed?", "I need to pay $400");
    expect(answerSentence(asked, "I owe $400 rent due 2026-10-01")).toBe(
      "I owe $400 rent due 2026-10-01",
    );
  });

  it("adds 'for' to a name that does not say it", () => {
    const asked = clarification("name", "What is $800 for?", "I need $800");
    expect(answerSentence(asked, "a laptop")).toBe("I need $800 for a laptop");
    expect(answerSentence(asked, "for a laptop")).toBe("I need $800 for a laptop");
  });

  it("replaces the fragment for a type question, since only saying it again settles it", () => {
    const asked = clarification(
      "type",
      "A goal or a reserve?",
      "save $3,000 for an emergency fund by December",
    );
    expect(answerSentence(asked, "keep $3,000 for emergencies")).toBe(
      "keep $3,000 for emergencies",
    );
  });

  it("changes nothing when the answer is blank", () => {
    const asked = clarification("amount", "How much?", "save for a trip");
    expect(answerSentence(asked, "   ")).toBe("save for a trip");
  });
});

describe("appendAnswers", () => {
  const text = "I want to save for a trip, and keep $300 in checking.";
  const howMuch = clarification("amount", "How much?", "I want to save for a trip");

  it("rewrites only the clause the question came from", () => {
    expect(appendAnswers(text, [{ clarification: howMuch, answer: "$2,000" }])).toBe(
      "I want to save $2,000 for a trip, and keep $300 in checking.",
    );
  });

  it("folds in several answers, each where its own question came from", () => {
    const byWhen = clarification("deadline", "By when?", "I want to save for a trip");
    expect(
      appendAnswers(text, [
        { clarification: howMuch, answer: "$2,000" },
        { clarification: byWhen, answer: "June 1" },
      ]),
    ).toBe("I want to save $2,000 for a trip by June 1, and keep $300 in checking.");
  });

  it("skips a blank answer", () => {
    expect(appendAnswers(text, [{ clarification: howMuch, answer: "" }])).toBe(text);
  });

  it("adds the answer as its own sentence when the fragment is gone", () => {
    const stale = clarification("deadline", "By when?", "a trip to Japan");
    expect(appendAnswers("I need $800 for a laptop.", [{ clarification: stale, answer: "May 1" }])).toBe(
      "I need $800 for a laptop. a trip to Japan by May 1",
    );
  });
});

describe("validateEdit", () => {
  const asOf = "2026-09-19";
  const laptop = goal("goal_laptop", "Laptop", 800, "2026-12-01");

  it("passes a row with no edits", () => {
    expect(isEditValid(validateEdit(laptop, undefined, asOf))).toBe(true);
    expect(isEditValid(validateEdit(laptop, {}, asOf))).toBe(true);
  });

  it("rejects an amount that is zero, negative or not a number", () => {
    for (const target_amount of ["0", "-50", "", "soon"]) {
      expect(validateEdit(laptop, { target_amount }, asOf).target_amount).toBeDefined();
    }
  });

  it("accepts an amount written with a dollar sign or commas", () => {
    expect(isEditValid(validateEdit(laptop, { target_amount: "$1,250" }, asOf))).toBe(true);
  });

  it("rejects a deadline on or before the twin's as_of date", () => {
    expect(validateEdit(laptop, { deadline: asOf }, asOf).deadline).toBeDefined();
    expect(validateEdit(laptop, { deadline: "2026-09-18" }, asOf).deadline).toBeDefined();
  });

  it("rejects a date that is not a real day", () => {
    expect(validateEdit(laptop, { deadline: "2027-02-31" }, asOf).deadline).toBeDefined();
    expect(validateEdit(laptop, { deadline: "next May" }, asOf).deadline).toBeDefined();
  });

  it("accepts a deadline after as_of", () => {
    expect(isEditValid(validateEdit(laptop, { deadline: "2026-12-01" }, asOf))).toBe(true);
  });

  it("reads blank progress as nothing saved yet", () => {
    expect(isEditValid(validateEdit(laptop, { current_amount: "" }, asOf))).toBe(true);
  });

  it("rejects progress that is negative or past the target", () => {
    expect(validateEdit(laptop, { current_amount: "-1" }, asOf).current_amount).toBeDefined();
    expect(validateEdit(laptop, { current_amount: "900" }, asOf).current_amount).toBeDefined();
  });

  it("measures progress against the edited target, not the drafted one", () => {
    const edit = { target_amount: "1200", current_amount: "900" };
    expect(isEditValid(validateEdit(laptop, edit, asOf))).toBe(true);
  });
});

describe("applyEdits", () => {
  const asOf = "2026-09-19";
  const laptop = goal("goal_laptop", "Laptop", 800, "2026-12-01");

  it("leaves a goal with no edits untouched", () => {
    expect(applyEdits([housing, laptop], {}, asOf)).toEqual([housing, laptop]);
  });

  it("applies a corrected amount, deadline and progress", () => {
    const edited = applyEdits(
      [laptop],
      { goal_laptop: { target_amount: "$1,200", deadline: "2027-01-15", current_amount: "250" } },
      asOf,
    );
    expect(edited).toEqual([
      { ...laptop, target_amount: 1200, deadline: "2027-01-15", current_amount: 250 },
    ]);
  });

  it("keeps the drafted value for a field that does not validate", () => {
    const edited = applyEdits(
      [laptop],
      { goal_laptop: { target_amount: "0", deadline: "2026-01-01" } },
      asOf,
    );
    expect(edited).toEqual([laptop]);
  });

  it("ignores edits for a goal that is no longer in the list", () => {
    expect(applyEdits([laptop], { goal_gone: { target_amount: "5" } }, asOf)).toEqual([laptop]);
  });

  it("edits only the goal it is keyed to", () => {
    const edited = applyEdits([housing, laptop], { goal_laptop: { target_amount: "900" } }, asOf);
    expect(edited[0]).toEqual(housing);
    expect(edited[1].target_amount).toBe(900);
  });
});
