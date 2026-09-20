import { describe, expect, it } from "vitest";

import mockSimulation from "@/lib/mock/simulation.json";
import { alternativeRows, compromiseIsApplyable } from "./alternatives";
import type {
  OptimizationCandidate,
  OptimizationResponse,
  ScenarioMetrics,
  SimulationResponse,
} from "./types";

const SIMULATION = mockSimulation as unknown as SimulationResponse;

function candidate(overrides: Partial<OptimizationCandidate> = {}): OptimizationCandidate {
  return {
    id: "cand_x",
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

const BUY_NOW = candidate({ id: "cand_buy_now", kind: "buy_now", label: "Buy now" });
const DELAY = candidate({ id: "cand_delay", kind: "delay" });
const DELAY_LONGER = candidate({ id: "cand_delay_60", kind: "delay" });
const CUT = candidate({
  id: "cand_cut_discretionary_50",
  kind: "reduce_spending",
  spending_adjustments: [{ category: "dining", multiplier: 0.5 }],
});
const SAVINGS = candidate({ id: "cand_from_savings", kind: "from_savings" });

function optimization(overrides: Partial<OptimizationResponse> = {}): OptimizationResponse {
  return {
    optimization_id: "opt-1",
    user_id: "alex",
    request: { user_id: "alex", events: SIMULATION.request.events },
    horizon_end: SIMULATION.horizon_end,
    baseline: SIMULATION.baseline,
    candidates: [BUY_NOW, DELAY, CUT],
    recommended_id: "cand_delay",
    summary: "Other ways to make this purchase.",
    assumptions: [],
    num_simulations: 1000,
    ...overrides,
  };
}

describe("alternativeRows", () => {
  // SM-11
  it("picks buy now, the recommendation, and a compromise on a different lever", () => {
    const rows = alternativeRows(optimization());
    expect(rows.map((r) => [r.key, r.label, r.candidate.id])).toEqual([
      ["buy_now", "Buy as planned", "cand_buy_now"],
      ["best", "Best alternative", "cand_delay"],
      ["compromise", "Compromise", "cand_cut_discretionary_50"],
    ]);
  });

  it("names the top candidate for what it is when nothing keeps every limit", () => {
    const rows = alternativeRows(
      optimization({
        recommended_id: null,
        // candidates[0] is the row that gets the label, whatever its kind.
        candidates: [
          { ...DELAY, meets_constraints: false, violations: ["Dips below the $1,500 reserve"] },
          BUY_NOW,
          CUT,
        ],
      }),
    );
    expect(rows[1].label).toBe("Closest to your limits");
    expect(rows[1].violations).toEqual(["Dips below the $1,500 reserve"]);
  });

  it("skips a compromise that would only repeat the lever already shown", () => {
    const rows = alternativeRows(
      optimization({ candidates: [BUY_NOW, DELAY, DELAY_LONGER] }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.key)).toEqual(["buy_now", "best"]);
  });

  it("does not list one candidate twice when the recommendation is buying as planned", () => {
    const rows = alternativeRows(
      optimization({ candidates: [BUY_NOW, DELAY], recommended_id: "cand_buy_now" }),
    );
    // The Best row would repeat the first, so it is dropped and the delay
    // becomes the compromise: a different lever, which is the point of the row.
    expect(rows.map((r) => [r.key, r.candidate.id])).toEqual([
      ["buy_now", "cand_buy_now"],
      ["compromise", "cand_delay"],
    ]);
  });

  it("takes the third lever when two are already spent", () => {
    const rows = alternativeRows(
      optimization({ candidates: [BUY_NOW, DELAY, SAVINGS], recommended_id: "cand_delay" }),
    );
    expect(rows[2].candidate.id).toBe("cand_from_savings");
  });

  it("returns nothing at all when the optimizer found nothing", () => {
    expect(alternativeRows(optimization({ candidates: [], recommended_id: null }))).toEqual([]);
  });

  // The consistency rule in 9.4: the Purchase column is authoritative.
  it("shows the simulate figures on Buy as planned, not the candidate's own", () => {
    const authoritative: ScenarioMetrics = { ...SIMULATION.counterfactual, ending_balance: 2596 };
    const drifted = { ...BUY_NOW, metrics: { ...SIMULATION.counterfactual, ending_balance: 2611 } };
    const rows = alternativeRows(
      optimization({ candidates: [drifted, DELAY, CUT] }),
      authoritative,
    );
    expect(rows[0].metrics.ending_balance).toBe(2596);
    // Every other row keeps the optimizer's own numbers.
    expect(rows[1].metrics).toBe(DELAY.metrics);
  });
});

describe("compromiseIsApplyable", () => {
  // SM-12 / Q4: nothing in the twin can record "spend 50% less on dining".
  it("refuses a compromise that depends on a spending cut", () => {
    const [, , compromise] = alternativeRows(optimization());
    expect(compromise.candidate.spending_adjustments).not.toEqual([]);
    expect(compromiseIsApplyable(compromise)).toBe(false);
  });

  it("allows one built only from events", () => {
    const rows = alternativeRows(
      optimization({ candidates: [BUY_NOW, DELAY, SAVINGS], recommended_id: "cand_delay" }),
    );
    expect(compromiseIsApplyable(rows[2])).toBe(true);
  });

  it("is false when there is no compromise row at all", () => {
    expect(compromiseIsApplyable(undefined)).toBe(false);
  });
});
