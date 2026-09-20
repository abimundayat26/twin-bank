import { describe, expect, it } from "vitest";

import mockTwin from "@/lib/mock/twin.json";
import type {
  AssistantQuestion,
  FinancialTwin,
  Proposal,
  SimulatePrefill,
} from "@/lib/types";
import {
  acceptedLabel,
  categoryForLabel,
  describeProposal,
  obligationForQuestion,
  readPrefillParams,
  simulateHref,
} from "./assistant";

const TWIN = mockTwin as unknown as FinancialTwin;

/** Every card carries the words it came from, so only the payload varies here. */
function base(id: string) {
  return {
    proposal_id: id,
    status: "pending" as const,
    source_fragment: "some words",
    requires_user_confirmation: true as const,
  };
}

describe("describeProposal", () => {
  it("words an added goal as PL-4 fixes it, with the year rule", () => {
    const proposal: Proposal = {
      ...base("p1"),
      action_type: "ADD_GOAL",
      goal: {
        id: "goal_trip",
        name: "Trip",
        target_amount: 2000,
        deadline: "2027-06-01",
        current_amount: 0,
        provenance: "declared",
      },
    };
    // 2027 is not the twin's as_of year (2026), so the year is shown (G-1).
    expect(describeProposal(proposal, TWIN).title).toBe(
      "Add goal: Trip, $2,000 by Jun 1, 2027",
    );
  });

  it("drops the year for a date inside the twin's own year", () => {
    const proposal: Proposal = {
      ...base("p2"),
      action_type: "ADD_GOAL",
      goal: {
        id: "goal_gift",
        name: "Gift",
        target_amount: 150,
        deadline: "2026-12-20",
        current_amount: 0,
        provenance: "declared",
      },
    };
    expect(describeProposal(proposal, TWIN).title).toBe("Add goal: Gift, $150 by Dec 20");
  });

  it("names the goal and every field an update changes", () => {
    const proposal: Proposal = {
      ...base("p3"),
      action_type: "UPDATE_GOAL",
      goal_id: "goal_summer_housing",
      goal_name: "Summer housing",
      changes: { target_amount: 2500, deadline: "2027-05-01" },
    };
    expect(describeProposal(proposal, TWIN).title).toBe(
      "Change Summer housing: target amount to $2,500 and target date to May 1, 2027",
    );
  });

  it("names the account a bill is paid from, and whether it must be paid", () => {
    const proposal: Proposal = {
      ...base("p4"),
      action_type: "ADD_OBLIGATION",
      obligation: {
        id: "ot_tuition",
        name: "Tuition",
        amount: 1200,
        due_date: "2027-01-15",
        account_id: "acc_checking",
        mandatory: true,
        provenance: "declared",
      },
    };
    const card = describeProposal(proposal, TWIN);
    expect(card.title).toBe(
      "Add bill: Tuition, $1,200 on Jan 15, 2027, paid from Everyday Checking",
    );
    expect(card.fields).toEqual([{ label: "Must pay", value: "Yes" }]);
  });

  it("reads a recurring update in the user's terms, not the field names", () => {
    const proposal: Proposal = {
      ...base("p5"),
      action_type: "UPDATE_OBLIGATION",
      obligation_id: "obl_hokie_property_mgmt_rent",
      obligation_name: "Hokie Property Mgmt Rent",
      kind: "recurring",
      recurring_changes: { amount: 1050 },
    };
    expect(describeProposal(proposal, TWIN).title).toBe(
      "Change Hokie Property Mgmt Rent: amount to $1,050",
    );
  });

  it("says which accounts a limit covers (AS-19)", () => {
    const reserve: Proposal = {
      ...base("p6"),
      action_type: "SET_CONSTRAINT",
      constraint: {
        id: "c_reserve",
        type: "minimum_reserve",
        amount: 1500,
        description: "Emergency reserve",
        provenance: "declared",
      },
    };
    const floor: Proposal = {
      ...base("p7"),
      action_type: "SET_CONSTRAINT",
      constraint: {
        id: "c_floor",
        type: "minimum_checking_balance",
        amount: 300,
        description: "Minimum checking balance",
        provenance: "declared",
      },
    };
    expect(describeProposal(reserve, TWIN).title).toBe(
      "Keep at least $1,500 in checking plus savings",
    );
    expect(describeProposal(floor, TWIN).title).toBe("Keep at least $300 in checking");
  });

  it("uses the category's label, never its enum name (G-5)", () => {
    const proposal: Proposal = {
      ...base("p8"),
      action_type: "CLASSIFY_OBLIGATION",
      classification: {
        obligation_id: "obl_online_transfer_to",
        obligation_name: "Online Transfer To",
        category: "savings_transfer",
        fragment: "the $50 transfer is savings",
      },
    };
    expect(describeProposal(proposal, TWIN).title).toBe(
      "Treat Online Transfer To as Savings transfer",
    );
  });
});

describe("acceptedLabel", () => {
  it("says Added for a new thing and Updated for a change (PL-5)", () => {
    const added: Proposal = {
      ...base("p9"),
      action_type: "ADD_GOAL",
      goal: {
        id: "g",
        name: "Trip",
        target_amount: 100,
        deadline: "2027-01-01",
        current_amount: 0,
        provenance: "declared",
      },
    };
    const updated: Proposal = {
      ...base("p10"),
      action_type: "UPDATE_GOAL",
      goal_id: "g",
      goal_name: "Trip",
      changes: { target_amount: 200 },
    };
    expect(acceptedLabel(added)).toBe("Added");
    expect(acceptedLabel(updated)).toBe("Updated");
  });
});

describe("categoryForLabel", () => {
  it("maps a label the user pressed back to its category", () => {
    expect(categoryForLabel("Savings transfer")).toBe("savings_transfer");
    expect(categoryForLabel("Debt repayment")).toBe("debt_repayment");
  });

  it("returns nothing for a label it does not know, rather than guessing", () => {
    expect(categoryForLabel("Something else")).toBeUndefined();
  });
});

describe("obligationForQuestion", () => {
  const question: AssistantQuestion = {
    question_id: "q1",
    text: "What is Online Transfer To ($50 a month)?",
    field: "category",
    choices: ["Savings transfer"],
    fragment: "Online Transfer To",
  };

  it("resolves the obligation the opening question names", () => {
    expect(obligationForQuestion(TWIN, question)).toBe("obl_online_transfer_to");
  });

  it("resolves nothing when no obligation matches", () => {
    expect(
      obligationForQuestion(TWIN, { ...question, fragment: "Gone" }),
    ).toBeUndefined();
  });
});

describe("simulateHref and readPrefillParams", () => {
  it("carries a what-if to the Simulator and back again", () => {
    const prefill: SimulatePrefill = { description: "Laptop", amount: 800, date: "2026-10-01" };
    const href = simulateHref(prefill);
    expect(href).toBe("/simulate?description=Laptop&amount=800&date=2026-10-01");
    expect(readPrefillParams(new URLSearchParams(href.split("?")[1]))).toEqual({
      description: "Laptop",
      amount: "800",
      date: "2026-10-01",
    });
  });

  it("omits a date the what-if did not give", () => {
    expect(simulateHref({ description: "Laptop", amount: 800 })).toBe(
      "/simulate?description=Laptop&amount=800",
    );
  });

  it("escapes a description rather than breaking the URL", () => {
    const href = simulateHref({ description: "flight & hotel", amount: 1200 });
    expect(readPrefillParams(new URLSearchParams(href.split("?")[1]))?.description).toBe(
      "flight & hotel",
    );
  });

  it("drops a parameter it cannot use instead of repairing it", () => {
    expect(
      readPrefillParams(new URLSearchParams("description=Laptop&amount=free&date=soon")),
    ).toEqual({ description: "Laptop" });
    expect(readPrefillParams(new URLSearchParams("amount=-5"))).toBeUndefined();
    expect(readPrefillParams(new URLSearchParams(""))).toBeUndefined();
  });
});
