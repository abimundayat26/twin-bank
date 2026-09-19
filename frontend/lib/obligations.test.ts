import { describe, expect, it } from "vitest";

import { groupObligations, isMandatory, needsAnswer, openQuestions } from "./obligations";
import type { FinancialObligation, FinancialTwin } from "./types";

function obligation(overrides: Partial<FinancialObligation>): FinancialObligation {
  return {
    id: "o1",
    name: "Rent",
    expected_amount: 975,
    due_day: 1,
    confidence: 0.99,
    mandatory: true,
    provenance: "observed",
    ...overrides,
  } as FinancialObligation;
}

function twinWith(obligations: FinancialObligation[]): FinancialTwin {
  return { obligations } as FinancialTwin;
}

describe("isMandatory", () => {
  it("follows the observed flag when nothing was declared", () => {
    expect(isMandatory(obligation({ mandatory: true }))).toBe(true);
    expect(isMandatory(obligation({ mandatory: false }))).toBe(false);
  });

  it("lets a declared bill or debt repayment override an observed optional", () => {
    expect(isMandatory(obligation({ mandatory: false, declared_category: "bill" }))).toBe(true);
    expect(
      isMandatory(obligation({ mandatory: false, declared_category: "debt_repayment" })),
    ).toBe(true);
  });

  it("lets any other declared category override an observed mandatory", () => {
    expect(isMandatory(obligation({ mandatory: true, declared_category: "optional_spending" }))).toBe(
      false,
    );
  });
});

describe("groupObligations", () => {
  it("puts each obligation in exactly one group", () => {
    const twin = twinWith([
      obligation({ id: "rent", mandatory: true }),
      obligation({ id: "gym", mandatory: false }),
      obligation({ id: "one-off", declared_category: "not_recurring", mandatory: false }),
    ]);
    const { upcoming, recurring, excluded } = groupObligations(twin);
    expect(upcoming.map((o) => o.id)).toEqual(["rent"]);
    expect(recurring.map((o) => o.id)).toEqual(["gym"]);
    expect(excluded.map((o) => o.id)).toEqual(["one-off"]);
    expect(upcoming.length + recurring.length + excluded.length).toBe(twin.obligations.length);
  });

  it("never counts a not-recurring obligation as a recurring expense", () => {
    const twin = twinWith([
      obligation({ id: "x", declared_category: "not_recurring", mandatory: false }),
    ]);
    expect(groupObligations(twin).recurring).toEqual([]);
  });
});

describe("needsAnswer / openQuestions", () => {
  it("asks only about obligations with candidate categories", () => {
    const asks = obligation({ id: "ask", category_candidates: [{ category: "bill" }] as never });
    const twin = twinWith([asks, obligation({ id: "known" })]);
    expect(needsAnswer(asks)).toBe(true);
    expect(needsAnswer(obligation({ id: "known" }))).toBe(false);
    expect(openQuestions(twin).map((o) => o.id)).toEqual(["ask"]);
  });

  it("treats an empty candidate list as nothing to ask", () => {
    expect(needsAnswer(obligation({ category_candidates: [] }))).toBe(false);
  });
});
