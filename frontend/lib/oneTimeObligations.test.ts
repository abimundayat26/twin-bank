/**
 * The merge is where a confirmed obligation would quietly be lost: `PUT
 * /twin/{id}/goals` replaces the whole set it is sent, and the compiler reuses
 * the id it derived from the name, so re-describing one must update it rather
 * than duplicate it.
 */

import { describe, expect, it } from "vitest";

import mockTwin from "@/lib/mock/twin.json";
import {
  accountName,
  applyOneTimeEdits,
  byDueDate,
  describeObligationChange,
  isOneTimeEditValid,
  mergeOneTimeObligations,
  removeOneTimeObligation,
  validateOneTimeEdit,
  withoutOneTimeObligation,
} from "./oneTimeObligations";
import type { Account, FinancialTwin, OneTimeObligation } from "./types";

const AS_OF = "2026-09-18";

const ACCOUNTS: Account[] = [
  { id: "acc_checking", name: "Everyday Checking", type: "checking", balance: 1340 },
  { id: "acc_savings", name: "Savings", type: "savings", balance: 1800 },
];

function owed(overrides: Partial<OneTimeObligation> = {}): OneTimeObligation {
  return {
    id: "one_car_insurance",
    name: "Car insurance",
    amount: 450,
    due_date: "2026-10-15",
    account_id: "acc_checking",
    mandatory: true,
    provenance: "declared",
    ...overrides,
  };
}

const TWIN = mockTwin as unknown as FinancialTwin;

describe("byDueDate", () => {
  it("puts the soonest due date first, whatever order they arrived in", () => {
    const sorted = byDueDate([
      owed({ id: "b", due_date: "2026-12-01" }),
      owed({ id: "a", due_date: "2026-10-15" }),
    ]);
    expect(sorted.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("does not reorder the array it was given", () => {
    const input = [owed({ id: "b", due_date: "2026-12-01" }), owed({ id: "a" })];
    byDueDate(input);
    expect(input.map((o) => o.id)).toEqual(["b", "a"]);
  });
});

describe("mergeOneTimeObligations", () => {
  it("appends an obligation the twin did not hold", () => {
    const merged = mergeOneTimeObligations([owed({ id: "one_tuition" })], [owed()]);
    expect(merged.map((o) => o.id)).toEqual(["one_tuition", "one_car_insurance"]);
  });

  // The compiler derives `one_<slug>` from the name and only dedupes within one
  // draft, so the backend would reject the repeat with "ids must be unique".
  it("updates in place when the draft reuses a confirmed id", () => {
    const merged = mergeOneTimeObligations([owed()], [owed({ amount: 500 })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].amount).toBe(500);
  });

  it("carries through an obligation the text never mentioned", () => {
    const merged = mergeOneTimeObligations([owed({ id: "one_tuition", amount: 2400 })], []);
    expect(merged).toEqual([owed({ id: "one_tuition", amount: 2400 })]);
  });

  it("collapses a repeated draft to its last version", () => {
    const merged = mergeOneTimeObligations([], [owed({ amount: 100 }), owed({ amount: 200 })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].amount).toBe(200);
  });
});

describe("describeObligationChange", () => {
  it("calls an unheld obligation new", () => {
    const changes = describeObligationChange([], [owed()]);
    expect(changes.get("one_car_insurance")).toBe("new");
  });

  it("calls an identical one unchanged, despite it being a fresh object", () => {
    const changes = describeObligationChange([owed()], [owed()]);
    expect(changes.get("one_car_insurance")).toBe("unchanged");
  });

  it.each([
    ["amount", { amount: 500 }],
    ["due date", { due_date: "2026-11-01" }],
    ["funding account", { account_id: "acc_savings" }],
    ["mandatory flag", { mandatory: false }],
    ["name", { name: "Car insurance premium" }],
  ])("notices a changed %s", (_label, change) => {
    const changes = describeObligationChange([owed()], [owed(change)]);
    expect(changes.get("one_car_insurance")).toBe("updated");
  });
});

describe("removing one", () => {
  it("drops only the obligation named", () => {
    const left = removeOneTimeObligation([owed(), owed({ id: "one_tuition" })], "one_tuition");
    expect(left.map((o) => o.id)).toEqual(["one_car_insurance"]);
  });

  it("removes nothing for an id it does not hold", () => {
    expect(removeOneTimeObligation([owed()], "one_nothing")).toHaveLength(1);
  });

  // The PUT replaces the whole declared set, so a removal that sent only the
  // obligations would delete every goal and the emergency reserve with them.
  it("sends the goals and constraints back untouched", () => {
    const twin = { ...TWIN, one_time_obligations: [owed()] };
    const request = withoutOneTimeObligation(twin, "one_car_insurance");
    expect(request.goals).toEqual(twin.goals);
    expect(request.constraints).toEqual(twin.constraints);
    expect(request.one_time_obligations).toEqual([]);
  });

  // An empty list clears them, which is exactly what a removal down to none is.
  it("clears with an empty list rather than by omitting the field", () => {
    const twin = { ...TWIN, one_time_obligations: [owed()] };
    expect(withoutOneTimeObligation(twin, "one_car_insurance")).toHaveProperty(
      "one_time_obligations",
    );
  });

  it("treats a twin without the field as holding none", () => {
    const older: FinancialTwin = { ...TWIN };
    delete older.one_time_obligations;
    const request = withoutOneTimeObligation(older, "one_car_insurance");
    expect(request.one_time_obligations).toEqual([]);
  });
});

describe("validating a correction", () => {
  const check = (edit: Parameters<typeof validateOneTimeEdit>[0]) =>
    validateOneTimeEdit(edit, AS_OF, ACCOUNTS);

  it("finds nothing wrong with an untouched row", () => {
    expect(isOneTimeEditValid(check(undefined))).toBe(true);
  });

  it("refuses an amount of zero, as the model does", () => {
    expect(check({ amount: "0" }).amount).toMatch(/above \$0/);
  });

  it("refuses a negative amount", () => {
    expect(check({ amount: "-25" }).amount).toMatch(/above \$0/);
  });

  it("refuses an amount that is not a number", () => {
    expect(check({ amount: "soon" }).amount).toBeDefined();
  });

  it("reads a typed amount the way the goal rows do", () => {
    expect(isOneTimeEditValid(check({ amount: "$1,200" }))).toBe(true);
  });

  // `check_one_time_obligations` rejects a due date on or before as_of.
  it("refuses a due date that is not after the twin's as_of", () => {
    expect(check({ due_date: AS_OF }).due_date).toMatch(new RegExp(AS_OF));
  });

  it("refuses a date that is ISO-shaped but not a real day", () => {
    expect(check({ due_date: "2026-02-31" }).due_date).toMatch(/YYYY-MM-DD/);
  });

  it("accepts a due date after as_of", () => {
    expect(isOneTimeEditValid(check({ due_date: "2026-10-15" }))).toBe(true);
  });

  // The backend refuses an account the twin does not hold, so the message
  // arrives next to the field rather than as a 400 after Confirm.
  it("refuses an account the twin does not hold", () => {
    expect(check({ account_id: "acc_someone_else" }).account_id).toMatch(/account you hold/);
  });

  it("refuses a blank name", () => {
    expect(check({ name: "   " }).name).toMatch(/name/);
  });

  it("has no opinion about the mandatory flag either way", () => {
    expect(isOneTimeEditValid(check({ mandatory: false }))).toBe(true);
  });
});

describe("applying corrections", () => {
  it("leaves an uncorrected obligation exactly as it was", () => {
    expect(applyOneTimeEdits([owed()], {}, AS_OF, ACCOUNTS)).toEqual([owed()]);
  });

  it("applies every corrected field", () => {
    const [result] = applyOneTimeEdits(
      [owed()],
      {
        one_car_insurance: {
          name: "Car insurance premium",
          amount: "$500",
          due_date: "2026-11-01",
          account_id: "acc_savings",
          mandatory: false,
        },
      },
      AS_OF,
      ACCOUNTS,
    );
    expect(result).toEqual({
      ...owed(),
      name: "Car insurance premium",
      amount: 500,
      due_date: "2026-11-01",
      account_id: "acc_savings",
      mandatory: false,
    });
  });

  it("trims a corrected name", () => {
    const [result] = applyOneTimeEdits(
      [owed()],
      { one_car_insurance: { name: "  Tuition  " } },
      AS_OF,
      ACCOUNTS,
    );
    expect(result.name).toBe("Tuition");
  });

  // Confirm is blocked while a row is invalid, so this only decides what is
  // shown meanwhile: the drafted value, never a half-typed one.
  it("keeps the drafted value for a field that does not validate", () => {
    const [result] = applyOneTimeEdits(
      [owed()],
      { one_car_insurance: { amount: "0", due_date: "2026-01-01" } },
      AS_OF,
      ACCOUNTS,
    );
    expect(result.amount).toBe(450);
    expect(result.due_date).toBe("2026-10-15");
  });

  it("never rewrites provenance, which is always declared", () => {
    const [result] = applyOneTimeEdits(
      [owed()],
      { one_car_insurance: { amount: "500" } },
      AS_OF,
      ACCOUNTS,
    );
    expect(result.provenance).toBe("declared");
  });

  it("ignores an edit keyed to an obligation that is no longer on screen", () => {
    const result = applyOneTimeEdits([owed()], { one_gone: { amount: "1" } }, AS_OF, ACCOUNTS);
    expect(result).toEqual([owed()]);
  });
});

describe("accountName", () => {
  it("names the account the obligation is paid from", () => {
    expect(accountName(ACCOUNTS, "acc_savings")).toBe("Savings");
  });

  // Better a raw id than a blank: the user can still see which account it means.
  it("falls back to the id when the twin no longer holds that account", () => {
    expect(accountName(ACCOUNTS, "acc_closed")).toBe("acc_closed");
  });
});
