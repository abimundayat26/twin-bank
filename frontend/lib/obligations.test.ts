import { describe, expect, it } from "vitest";

import {
  groupObligations,
  isMandatory,
  needsAnswer,
  offlineObligations,
  openQuestions,
} from "./obligations";
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

describe("offlineObligations", () => {
  /** The saved twin the page reshapes when the backend cannot be reached (G-10). */
  const twin = {
    user_id: "alex",
    as_of: "2026-09-18",
    accounts: [
      { id: "acc_checking", name: "Everyday Checking" },
      { id: "acc_savings", name: "Savings" },
    ],
    obligations: [
      obligation({ id: "rec_phone", name: "Verizon", due_day: 20, expected_amount: 85 }),
      obligation({
        id: "rec_transfer",
        name: "Online Transfer To",
        due_day: 5,
        category_candidates: [
          { category: "savings_transfer", probability: 0.7 },
          { category: "debt_repayment", probability: 0.3 },
        ] as never,
      }),
      obligation({
        id: "rec_gym",
        name: "Gym",
        due_day: 5,
        active: false,
        provenance: "declared",
        declared_category: "optional_spending",
      }),
    ],
    one_time_obligations: [
      {
        id: "one_past",
        name: "Already paid",
        amount: 50,
        due_date: "2026-09-18",
        account_id: "acc_checking",
        mandatory: true,
        provenance: "declared",
      },
      {
        id: "one_dentist",
        name: "Dentist",
        amount: 180,
        due_date: "2026-10-02",
        account_id: "acc_savings",
        mandatory: false,
        provenance: "declared",
      },
    ],
  } as unknown as FinancialTwin;

  it("renames contract fields without deriving any value", () => {
    const transfer = offlineObligations(twin).recurring?.find((r) => r.id === "rec_transfer");
    expect(transfer).toMatchObject({
      id: "rec_transfer",
      name: "Online Transfer To",
      amount: 975,
      frequency: "monthly",
      due_day: 5,
      active: true,
      origin: "detected",
      category_label: null,
      needs_answer: true,
    });
  });

  it("orders rows the way the read endpoint does (OB-10)", () => {
    const listing = offlineObligations(twin);
    expect(listing.recurring?.map((row) => row.id)).toEqual([
      "rec_gym",
      "rec_transfer",
      "rec_phone",
    ]);
  });

  it("drops candidate probabilities but keeps the likelihood order (G-5, OB-9)", () => {
    const transfer = offlineObligations(twin).recurring?.find((r) => r.id === "rec_transfer");
    expect(transfer?.options).toEqual([
      { category: "savings_transfer", label: "Savings transfer" },
      { category: "debt_repayment", label: "Debt repayment" },
    ]);
  });

  it("reports a declared category in words and stops asking about it (OB-4)", () => {
    const gym = offlineObligations(twin).recurring?.find((row) => row.id === "rec_gym");
    expect(gym).toMatchObject({
      origin: "declared",
      active: false,
      category_label: "Optional spending",
      needs_answer: false,
    });
  });

  it("keeps only upcoming one-time rows and names their account (OB-8)", () => {
    const listing = offlineObligations(twin);
    expect(listing.one_time).toEqual([
      {
        id: "one_dentist",
        name: "Dentist",
        amount: 180,
        due_date: "2026-10-02",
        account_id: "acc_savings",
        account_name: "Savings",
        mandatory: false,
      },
    ]);
  });
});
