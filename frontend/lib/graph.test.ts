import { describe, expect, it } from "vitest";

import {
  COLUMN_X,
  DAYS_PER_MONTH,
  MAX_ROWS_PER_COLUMN,
  MAX_STROKE,
  MIN_STROKE,
  NODE_WIDTH,
  ROW_GAP,
  buildIntentGraph,
  checkingFloorConstraint,
  columnY,
  declaredX,
  describeIntentGraph,
  intentStages,
  enforcedReserveConstraint,
  goalFlag,
  isMandatory,
  monthlyEquivalent,
  outflowColumns,
  outflowPosition,
  primaryAccountId,
  reserveFlag,
  savingsAccountId,
  strokeWidthFor,
  sweepChance,
  type IntentNode,
} from "./graph";
import type {
  FinancialObligation,
  FinancialTwin,
  ScenarioMetrics,
  SimulationResponse,
} from "./types";

/**
 * Deliberately not Alex: a test that only ever sees the demo fixture passes for
 * the wrong reasons. These are obviously-fake numbers that are easy to reason
 * about, and each builder takes an override for the one thing a test cares about.
 */
function makeTwin(overrides: Partial<FinancialTwin> = {}): FinancialTwin {
  return {
    user_id: "tester",
    display_name: "Tester",
    as_of: "2026-01-01",
    accounts: [
      { id: "acc_checking", name: "Checking", type: "checking", balance: 1000 },
      { id: "acc_savings", name: "Savings", type: "savings", balance: 500 },
    ],
    income: [
      {
        id: "inc_job",
        source: "Paycheck",
        expected_amount: 700,
        interval_days: 14,
        next_date: "2026-01-08",
        uncertainty: 50,
        provenance: "observed",
      },
    ],
    obligations: [
      {
        id: "obl_rent",
        name: "Rent",
        expected_amount: 600,
        due_day: 1,
        mandatory: true,
        confidence: 0.99,
        provenance: "observed",
      },
      {
        id: "obl_streaming",
        name: "Streaming",
        expected_amount: 20,
        due_day: 10,
        mandatory: false,
        confidence: 0.9,
        provenance: "observed",
      },
    ],
    variable_spending: [
      { category: "groceries", mean_14d: 140, std_dev_14d: 30, provenance: "observed" },
    ],
    goals: [
      {
        id: "goal_a",
        name: "Trip",
        target_amount: 800,
        deadline: "2026-07-01",
        current_amount: 0,
        provenance: "declared",
      },
    ],
    constraints: [
      {
        id: "con_reserve",
        type: "minimum_reserve",
        amount: 400,
        description: "Keep at least $400.",
        provenance: "declared",
      },
    ],
    total_balance: 1500,
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<ScenarioMetrics> = {}): ScenarioMetrics {
  return {
    ending_balance: 1500,
    min_balance: 1200,
    prob_low_balance: 0,
    prob_below_reserve: 0,
    goal_shortfall: 0,
    obligations_covered: true,
    ...overrides,
  };
}

function makeSimulation(overrides: Partial<SimulationResponse> = {}): SimulationResponse {
  return {
    simulation_id: "sim_test",
    user_id: "tester",
    request: {
      user_id: "tester",
      events: [
        {
          type: "purchase",
          description: "Laptop",
          amount: 800,
          date: "2026-01-02",
          account_id: "acc_checking",
        },
      ],
    },
    horizon_end: "2026-07-01",
    baseline: makeMetrics(),
    counterfactual: makeMetrics({ ending_balance: 700, min_balance: 400 }),
    summary: "A summary.",
    drivers: [
      { label: "Laptop", impact_amount: -800, direction: "negative", detail: "One-time." },
    ],
    assumptions: ["Deterministic projection."],
    is_mock: false,
    ...overrides,
  };
}

const obligation = (o: Partial<FinancialObligation> = {}): FinancialObligation => ({
  id: "obl_x",
  name: "Thing",
  expected_amount: 10,
  due_day: 1,
  mandatory: true,
  confidence: 1,
  provenance: "observed",
  ...o,
});

const byId = (nodes: IntentNode[]) => new Map(nodes.map((node) => [node.id, node]));
const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("monthlyEquivalent", () => {
  it("normalises a 14-day flow onto a month", () => {
    expect(monthlyEquivalent(700, 14)).toBeCloseTo((700 * DAYS_PER_MONTH) / 14, 6);
  });

  it("leaves a monthly flow alone", () => {
    expect(monthlyEquivalent(600, DAYS_PER_MONTH)).toBeCloseTo(600, 6);
  });

  it("ranks a 14-day $700 paycheck above $600 of monthly rent", () => {
    // The point of normalising: raw amounts would rank these the other way.
    expect(monthlyEquivalent(700, 14)).toBeGreaterThan(monthlyEquivalent(600, DAYS_PER_MONTH));
  });

  it("returns 0 for a non-positive or non-finite interval", () => {
    expect(monthlyEquivalent(100, 0)).toBe(0);
    expect(monthlyEquivalent(100, -14)).toBe(0);
    expect(monthlyEquivalent(Number.NaN, 14)).toBe(0);
    expect(monthlyEquivalent(100, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("strokeWidthFor", () => {
  it("gives the largest flow the maximum width", () => {
    expect(strokeWidthFor(500, 500)).toBe(MAX_STROKE);
  });

  it("keeps the thinnest flow visible", () => {
    expect(strokeWidthFor(0, 500)).toBe(MIN_STROKE);
    expect(strokeWidthFor(1, 1_000_000)).toBeGreaterThanOrEqual(MIN_STROKE);
  });

  it("scales in between and clamps beyond the maximum", () => {
    expect(strokeWidthFor(250, 500)).toBeCloseTo((MIN_STROKE + MAX_STROKE) / 2, 6);
    expect(strokeWidthFor(900, 500)).toBe(MAX_STROKE);
  });

  it("falls back to the minimum when there is no maximum", () => {
    expect(strokeWidthFor(100, 0)).toBe(MIN_STROKE);
    expect(strokeWidthFor(100, Number.NaN)).toBe(MIN_STROKE);
  });
});

describe("layout", () => {
  it("centres a column symmetrically and orders rows top to bottom", () => {
    expect(columnY(0, 1)).toBe(0);
    expect(columnY(0, 2)).toBe(-columnY(1, 2));
    expect(columnY(0, 3)).toBeLessThan(columnY(1, 3));
  });

  it("leaves room for the tallest node a row can hold", () => {
    // A node with a two-line hint and a badge runs to about 130px. A gap under
    // that silently overlaps rows, which no assertion about x positions catches.
    expect(ROW_GAP).toBeGreaterThan(130);
  });

  it("wraps outflows past the row limit rather than growing taller", () => {
    expect(outflowColumns(1)).toBe(1);
    expect(outflowColumns(MAX_ROWS_PER_COLUMN)).toBe(1);
    expect(outflowColumns(MAX_ROWS_PER_COLUMN + 1)).toBe(2);
  });

  it("handles a count of zero without dividing by it", () => {
    expect(outflowColumns(0)).toBe(1);
    const { x, y } = outflowPosition(0, 0);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
  });

  it("never overlaps two wrapped outflows", () => {
    const count = 7;
    const placed = Array.from({ length: count }, (_, index) => outflowPosition(index, count));
    expect(new Set(placed.map((p) => `${p.x},${p.y}`)).size).toBe(count);
    for (const a of placed) {
      for (const b of placed) {
        if (a === b) continue;
        expect(Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < ROW_GAP).toBe(false);
      }
    }
  });

  it("puts the declared column clear of however many outflow columns there are", () => {
    expect(declaredX(8)).toBeGreaterThan(declaredX(3));
    expect(declaredX(3)).toBeGreaterThan(COLUMN_X.outflow + NODE_WIDTH);
  });
});

describe("engine mirrors", () => {
  it("routes through the first checking account, whatever its position", () => {
    expect(primaryAccountId(makeTwin())).toBe("acc_checking");
    const savingsFirst = makeTwin({
      accounts: [
        { id: "acc_savings", name: "Savings", type: "savings", balance: 500 },
        { id: "acc_checking", name: "Checking", type: "checking", balance: 100 },
      ],
    });
    expect(primaryAccountId(savingsFirst)).toBe("acc_checking");
  });

  it("falls back to the first account of any type, and is undefined with none", () => {
    const savingsOnly = makeTwin({
      accounts: [{ id: "acc_savings", name: "Savings", type: "savings", balance: 500 }],
    });
    expect(primaryAccountId(savingsOnly)).toBe("acc_savings");
    expect(primaryAccountId(makeTwin({ accounts: [] }))).toBeUndefined();
  });

  it("finds the savings account the engine would sweep from", () => {
    expect(savingsAccountId(makeTwin())).toBe("acc_savings");
    expect(savingsAccountId(makeTwin({ accounts: [] }))).toBeUndefined();
  });

  it("takes the largest declared reserve, as reserve_amount does", () => {
    const twin = makeTwin({
      constraints: [
        {
          id: "con_small",
          type: "minimum_reserve",
          amount: 400,
          description: "Small.",
          provenance: "declared",
        },
        {
          id: "con_big",
          type: "minimum_reserve",
          amount: 900,
          description: "Big.",
          provenance: "declared",
        },
      ],
    });
    expect(enforcedReserveConstraint(twin)?.id).toBe("con_big");
    expect(enforcedReserveConstraint(makeTwin({ constraints: [] }))).toBeUndefined();
  });

  it("keeps the two constraint types apart", () => {
    const twin = makeTwin({
      constraints: [
        {
          id: "con_reserve",
          type: "minimum_reserve",
          amount: 400,
          description: "Reserve.",
          provenance: "declared",
        },
        {
          id: "con_floor",
          type: "minimum_checking_balance",
          amount: 250,
          description: "Floor.",
          provenance: "declared",
        },
      ],
    });
    expect(enforcedReserveConstraint(twin)?.id).toBe("con_reserve");
    expect(checkingFloorConstraint(twin)?.id).toBe("con_floor");
  });

  it("lets a declared category override the observed mandatory flag", () => {
    // engine.is_mandatory. Reading `mandatory` alone would label a bill Alex
    // declared optional as mandatory, and the engine would disagree.
    expect(isMandatory(obligation({ mandatory: true }))).toBe(true);
    expect(isMandatory(obligation({ mandatory: false }))).toBe(false);
    expect(isMandatory(obligation({ mandatory: false, declared_category: "bill" }))).toBe(true);
    expect(
      isMandatory(obligation({ mandatory: false, declared_category: "debt_repayment" })),
    ).toBe(true);
    expect(
      isMandatory(obligation({ mandatory: true, declared_category: "optional_spending" })),
    ).toBe(false);
    expect(
      isMandatory(obligation({ mandatory: true, declared_category: "savings_transfer" })),
    ).toBe(false);
    expect(isMandatory(obligation({ mandatory: true, declared_category: null }))).toBe(true);
  });
});

describe("buildIntentGraph nodes", () => {
  it("turns every twin fact into exactly one node", () => {
    const { nodes } = buildIntentGraph(makeTwin());
    expect(ids(nodes)).toEqual([
      "income:inc_job",
      "account:acc_checking",
      "account:acc_savings",
      "obligation:obl_rent",
      "obligation:obl_streaming",
      "spending:0",
      "goal:goal_a",
      "reserve:con_reserve",
    ]);
  });

  it("puts each kind in its own column", () => {
    const at = byId(buildIntentGraph(makeTwin()).nodes);
    expect(at.get("income:inc_job")?.position.x).toBe(COLUMN_X.income);
    expect(at.get("account:acc_checking")?.position.x).toBe(COLUMN_X.account);
    expect(at.get("obligation:obl_rent")?.position.x).toBe(COLUMN_X.outflow);
    expect(at.get("goal:goal_a")?.position.x).toBe(declaredX(3));
  });

  it("gives every node a distinct position", () => {
    const { nodes } = buildIntentGraph(makeTwin());
    expect(new Set(nodes.map((n) => `${n.position.x},${n.position.y}`)).size).toBe(nodes.length);
  });

  it("keeps ids unique when two spending buckets share a category name", () => {
    // `category` is a display string the schema does not make unique, so nodes
    // are keyed by position. Keying on the name would drop a whole bucket.
    const twin = makeTwin({
      variable_spending: [
        { category: "food", mean_14d: 10, std_dev_14d: 1, provenance: "observed" },
        { category: "food", mean_14d: 20, std_dev_14d: 2, provenance: "observed" },
      ],
    });
    const { nodes, edges } = buildIntentGraph(twin);
    expect(nodes.filter((n) => n.data.kind === "spending")).toHaveLength(2);
    expect(new Set(ids(nodes)).size).toBe(nodes.length);
    expect(new Set(ids(edges)).size).toBe(edges.length);
  });

  it("carries provenance onto observed and declared nodes alike", () => {
    const at = byId(buildIntentGraph(makeTwin()).nodes);
    expect(at.get("income:inc_job")?.data.provenance).toBe("observed");
    expect(at.get("goal:goal_a")?.data.provenance).toBe("declared");
    expect(at.get("reserve:con_reserve")?.data.provenance).toBe("declared");
  });

  it("is empty for a twin with no accounts, rather than floating bills", () => {
    // The engine refuses this twin outright ("Twin has no accounts").
    const graph = buildIntentGraph(makeTwin({ accounts: [] }));
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it("shows a declared checking floor alongside the reserve", () => {
    const twin = makeTwin({
      constraints: [
        ...makeTwin().constraints,
        {
          id: "con_floor",
          type: "minimum_checking_balance",
          amount: 250,
          description: "Keep $250 in checking.",
          provenance: "declared",
        },
      ],
    });
    const at = byId(buildIntentGraph(twin).nodes);
    expect(at.get("checking_floor:con_floor")?.data.value).toBe("$250");
    expect(at.get("checking_floor:con_floor")?.data.provenance).toBe("declared");
  });
});

describe("buildIntentGraph labels", () => {
  it("prints contract figures verbatim", () => {
    const at = byId(buildIntentGraph(makeTwin()).nodes);
    expect(at.get("income:inc_job")?.data.value).toBe("$700");
    expect(at.get("income:inc_job")?.data.hint).toBe("Every 14 days · next January 8, 2026");
    expect(at.get("obligation:obl_rent")?.data.value).toBe("$600");
    expect(at.get("obligation:obl_rent")?.data.hint).toBe("Due the 1st");
    expect(at.get("spending:0")?.data.value).toBe("$140 / 14d");
    expect(at.get("goal:goal_a")?.data.value).toBe("$0 / $800");
    expect(at.get("account:acc_checking")?.data.value).toBe("$1,000.00");
  });

  it("never prints a monthly-equivalent figure anywhere", () => {
    // $700 every 14 days normalises to ~$1,522/month. That number is a frontend
    // derivation, so it may reach a stroke width and nothing else.
    const monthly = Math.round(monthlyEquivalent(700, 14));
    const text = buildIntentGraph(makeTwin())
      .nodes.map((n) => [n.data.title, n.data.value, n.data.hint, n.data.flag?.text])
      .flat()
      .join(" ");
    expect(text).not.toContain(String(monthly));
    expect(text).not.toContain(monthly.toLocaleString("en-US"));
  });

  it("flags an obligation the user declared optional, not just an observed one", () => {
    const twin = makeTwin({
      obligations: [
        obligation({ id: "obl_gym", name: "Gym", mandatory: true, declared_category: "optional_spending" }),
        obligation({ id: "obl_rent", name: "Rent", mandatory: true }),
      ],
    });
    const at = byId(buildIntentGraph(twin).nodes);
    expect(at.get("obligation:obl_gym")?.data.flag?.text).toBe("Optional");
    expect(at.get("obligation:obl_rent")?.data.flag).toBeUndefined();
  });

  it("shows the largest declared reserve, which is the one the engine enforces", () => {
    const twin = makeTwin({
      constraints: [
        {
          id: "con_small",
          type: "minimum_reserve",
          amount: 400,
          description: "Small.",
          provenance: "declared",
        },
        {
          id: "con_big",
          type: "minimum_reserve",
          amount: 900,
          description: "Big.",
          provenance: "declared",
        },
      ],
    });
    const reserves = buildIntentGraph(twin).nodes.filter((n) => n.data.kind === "reserve");
    expect(ids(reserves)).toEqual(["reserve:con_big"]);
    expect(reserves[0].data.value).toBe("$900");
  });
});

describe("buildIntentGraph edges", () => {
  it("routes income in and obligations and spending out of the primary account", () => {
    const { edges } = buildIntentGraph(makeTwin());
    expect(ids(edges)).toEqual(
      expect.arrayContaining([
        "income:inc_job->account:acc_checking",
        "account:acc_checking->obligation:obl_rent",
        "account:acc_checking->spending:0",
      ]),
    );
  });

  it("measures the goal and the reserve against every account", () => {
    // engine.evaluate_goals reads the TOTAL balance, so savings carries an edge.
    const { edges } = buildIntentGraph(makeTwin());
    expect(ids(edges)).toEqual(
      expect.arrayContaining([
        "account:acc_checking->goal:goal_a",
        "account:acc_savings->goal:goal_a",
        "account:acc_checking->reserve:con_reserve",
        "account:acc_savings->reserve:con_reserve",
      ]),
    );
  });

  it("ties the checking floor to checking alone, since it constrains one account", () => {
    const twin = makeTwin({
      constraints: [
        {
          id: "con_floor",
          type: "minimum_checking_balance",
          amount: 250,
          description: "Floor.",
          provenance: "declared",
        },
      ],
    });
    const { edges } = buildIntentGraph(twin);
    expect(ids(edges)).toContain("account:acc_checking->checking_floor:con_floor");
    expect(ids(edges)).not.toContain("account:acc_savings->checking_floor:con_floor");
  });

  it("draws no edge between accounts until a simulation reports a sweep", () => {
    // engine.sweep_from_savings is a fallback, not a standing transfer: drawing
    // it unconditionally would show money moving that usually does not.
    const { edges } = buildIntentGraph(makeTwin());
    const between = edges.filter(
      (e) => e.source.startsWith("account:") && e.target.startsWith("account:"),
    );
    expect(between).toEqual([]);
  });

  it("draws the savings sweep when the engine reports one", () => {
    const simulation = makeSimulation({
      counterfactual: makeMetrics({ prob_savings_sweep: 0.42 }),
    });
    const { edges } = buildIntentGraph(makeTwin(), simulation);
    const sweep = edges.find((e) => e.id === "account:acc_savings->account:acc_checking");
    expect(sweep).toBeDefined();
    expect(sweep?.label).toBe("Covers a bill in 42% of futures");
  });

  it("does not draw a sweep for a twin with no savings account", () => {
    const twin = makeTwin({
      accounts: [{ id: "acc_checking", name: "Checking", type: "checking", balance: 100 }],
    });
    const simulation = makeSimulation({
      counterfactual: makeMetrics({ prob_savings_sweep: 0.5 }),
    });
    const { edges } = buildIntentGraph(twin, simulation);
    const between = edges.filter(
      (e) => e.source.startsWith("account:") && e.target.startsWith("account:"),
    );
    expect(between).toEqual([]);
  });

  it("gives a bigger flow a thicker line", () => {
    const { edges } = buildIntentGraph(makeTwin());
    const rent = edges.find((e) => e.id === "account:acc_checking->obligation:obl_rent");
    const streaming = edges.find((e) => e.id === "account:acc_checking->obligation:obl_streaming");
    expect(Number(rent?.style?.strokeWidth)).toBeGreaterThan(Number(streaming?.style?.strokeWidth));
  });

  it("gives every edge a unique id and both ends a node that exists", () => {
    const { nodes, edges } = buildIntentGraph(makeTwin(), makeSimulation());
    const present = new Set(ids(nodes));
    expect(new Set(ids(edges)).size).toBe(edges.length);
    for (const edge of edges) {
      expect(present).toContain(edge.source);
      expect(present).toContain(edge.target);
    }
  });
});

describe("buildIntentGraph with a simulation", () => {
  it("adds no purchase node without one", () => {
    expect(buildIntentGraph(makeTwin()).nodes.filter((n) => n.data.kind === "purchase")).toEqual(
      [],
    );
  });

  it("adds a purchase node labelled from the request", () => {
    const at = byId(buildIntentGraph(makeTwin(), makeSimulation()).nodes);
    expect(at.get("purchase:0")?.data.title).toBe("Laptop");
    expect(at.get("purchase:0")?.data.value).toBe("$800");
    expect(at.get("purchase:0")?.data.hint).toBe("January 2, 2026");
    expect(at.get("purchase:0")?.data.flag?.text).toBe("Hypothetical");
  });

  it("attaches the purchase to the account it is paid from, not to checking", () => {
    const simulation = makeSimulation({
      request: {
        user_id: "tester",
        events: [
          {
            type: "purchase",
            description: "Laptop",
            amount: 800,
            date: "2026-01-02",
            account_id: "acc_savings",
          },
        ],
      },
    });
    const { edges } = buildIntentGraph(makeTwin(), simulation);
    expect(ids(edges)).toContain("account:acc_savings->purchase:0");
    expect(ids(edges)).not.toContain("account:acc_checking->purchase:0");
  });

  it("gives an event on an unknown account neither node nor edge", () => {
    // The engine rejects the request too (validate_events); a node on its own
    // would float unattached beside the graph.
    const simulation = makeSimulation({
      request: {
        user_id: "tester",
        events: [
          {
            type: "purchase",
            description: "Laptop",
            amount: 800,
            date: "2026-01-02",
            account_id: "acc_ghost",
          },
        ],
      },
    });
    const { nodes, edges } = buildIntentGraph(makeTwin(), simulation);
    expect(nodes.filter((n) => n.data.kind === "purchase")).toEqual([]);
    expect(ids(edges).some((id) => id.includes("purchase:0"))).toBe(false);
  });

  it("keeps the original index when an earlier event was skipped", () => {
    const event = {
      type: "purchase" as const,
      description: "Laptop",
      amount: 800,
      date: "2026-01-02",
      account_id: "acc_ghost",
    };
    const simulation = makeSimulation({
      request: {
        user_id: "tester",
        events: [event, { ...event, description: "Desk", account_id: "acc_checking" }],
      },
    });
    const purchases = buildIntentGraph(makeTwin(), simulation).nodes.filter(
      (n) => n.data.kind === "purchase",
    );
    expect(ids(purchases)).toEqual(["purchase:1"]);
    expect(purchases[0].data.title).toBe("Desk");
  });
});

describe("goalFlag", () => {
  const twin = makeTwin();

  it("is absent with no simulation, and when the goal is met", () => {
    expect(goalFlag(twin, "2026-07-01", null)).toBeUndefined();
    expect(
      goalFlag(twin, "2026-07-01", makeSimulation({ counterfactual: makeMetrics() })),
    ).toBeUndefined();
  });

  it("reports the shortfall the engine computed", () => {
    const simulation = makeSimulation({
      counterfactual: makeMetrics({ goal_shortfall: 233.57 }),
    });
    expect(goalFlag(twin, "2026-07-01", simulation)?.text).toBe("$234 short");
  });

  it("stays silent with two goals, because the shortfall is their sum", () => {
    // ScenarioMetrics.goal_shortfall totals every evaluated goal, so pinning it
    // on one of them would be an invention.
    const twoGoals = makeTwin({
      goals: [
        ...twin.goals,
        {
          id: "goal_b",
          name: "Bike",
          target_amount: 300,
          deadline: "2026-06-01",
          current_amount: 0,
          provenance: "declared",
        },
      ],
    });
    const simulation = makeSimulation({ counterfactual: makeMetrics({ goal_shortfall: 500 }) });
    expect(goalFlag(twoGoals, "2026-07-01", simulation)).toBeUndefined();
  });

  it("stays silent for a goal past the horizon, which the engine never evaluated", () => {
    const simulation = makeSimulation({
      horizon_end: "2026-03-01",
      counterfactual: makeMetrics({ goal_shortfall: 500 }),
    });
    expect(goalFlag(twin, "2026-07-01", simulation)).toBeUndefined();
  });
});

describe("reserveFlag", () => {
  it("is absent with no simulation, and when the reserve holds", () => {
    expect(reserveFlag(null)).toBeUndefined();
    expect(reserveFlag(makeSimulation())).toBeUndefined();
  });

  it("states the share of futures, the way the comparison table does", () => {
    const simulation = makeSimulation({
      counterfactual: makeMetrics({ prob_below_reserve: 0.3 }),
    });
    expect(reserveFlag(simulation)?.text).toBe("Dips below in 30% of futures");
  });

  it("does not round a rare dip away to nothing", () => {
    // `chance` renders this as "<1%" rather than "0%", which would read as safe.
    const simulation = makeSimulation({
      counterfactual: makeMetrics({ prob_below_reserve: 0.001 }),
    });
    expect(reserveFlag(simulation)?.text).toBe("Dips below in <1% of futures");
  });

  it("is definite when every future dips", () => {
    const simulation = makeSimulation({
      counterfactual: makeMetrics({ prob_below_reserve: 1 }),
    });
    expect(reserveFlag(simulation)?.text).toBe("Dips below");
  });
});

describe("sweepChance", () => {
  it("is zero when absent, null or not reported", () => {
    expect(sweepChance(null)).toBe(0);
    expect(sweepChance(makeSimulation())).toBe(0);
    expect(
      sweepChance(makeSimulation({ counterfactual: makeMetrics({ prob_savings_sweep: null }) })),
    ).toBe(0);
  });

  it("passes a reported share through", () => {
    expect(
      sweepChance(makeSimulation({ counterfactual: makeMetrics({ prob_savings_sweep: 0.25 }) })),
    ).toBe(0.25);
  });
});

describe("describeIntentGraph", () => {
  it("states the structure for a screen reader", () => {
    const text = describeIntentGraph(makeTwin());
    expect(text).toContain("1 income stream into Checking");
    expect(text).toContain("3 recurring outflows");
    expect(text).toContain("2 accounts hold $1,500.00");
    expect(text).toContain("1 declared goal");
  });

  it("names the purchase and the account it comes from", () => {
    const text = describeIntentGraph(makeTwin(), makeSimulation());
    expect(text).toContain("A hypothetical $800 laptop is paid from Checking on January 2, 2026.");
  });

  it("does not announce a purchase the graph did not draw", () => {
    // lib/api.ts falls back to fixtures per call, so a live twin can arrive
    // beside a saved simulation whose account it does not have.
    const simulation = makeSimulation({
      request: {
        user_id: "tester",
        events: [
          {
            type: "purchase",
            description: "Laptop",
            amount: 800,
            date: "2026-01-02",
            account_id: "acc_ghost",
          },
        ],
      },
    });
    expect(describeIntentGraph(makeTwin(), simulation)).not.toContain("hypothetical");
  });

  it("says so plainly when there is nothing to graph", () => {
    expect(describeIntentGraph(makeTwin({ accounts: [] }))).toBe("No accounts to graph.");
  });

  it("agrees its verb with a single account", () => {
    const text = describeIntentGraph(
      makeTwin({
        accounts: [{ id: "acc_checking", name: "Checking", type: "checking", balance: 10 }],
      }),
    );
    expect(text).toContain("1 account holds");
  });
});


describe("reading the graph as a list", () => {
  // SPEC 5.3 requires a non-canvas representation. It is built from the graph's own
  // nodes, so these tests are really about it never disagreeing with the picture.

  it("follows the section 5.1 order", () => {
    const stages = intentStages(buildIntentGraph(makeTwin()));
    expect(stages.map((s) => s.title)).toEqual([
      "Accounts",
      "Income and spending",
      "Obligations and constraints",
      "Goals",
    ]);
  });

  it("accounts for every node exactly once", () => {
    const graph = buildIntentGraph(makeTwin());
    const listed = intentStages(graph).flatMap((s) => s.nodes.map((n) => n.id));
    expect(listed.slice().sort()).toEqual(graph.nodes.map((n) => n.id).sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("leaves out a stage the twin has nothing for", () => {
    const stages = intentStages(buildIntentGraph(makeTwin({ goals: [] })));
    expect(stages.map((s) => s.title)).not.toContain("Goals");
  });

  it("keeps a hypothetical purchase out of the committed money", () => {
    // The same distinction the explanation drivers make: a purchase under
    // consideration must not be listed among obligations already owed.
    const graph = buildIntentGraph(makeTwin(), makeSimulation());
    const stages = intentStages(graph);
    const purchase = stages.find((s) => s.title === "Hypothetical purchase");
    expect(purchase?.nodes).toHaveLength(1);
    const committed = stages.find((s) => s.title === "Obligations and constraints");
    expect(committed?.nodes.some((n) => n.data.kind === "purchase")).toBe(false);
  });

  it("is empty for a twin with nothing to draw", () => {
    expect(intentStages(buildIntentGraph(makeTwin({ accounts: [] })))).toEqual([]);
  });
});

describe("a dense twin", () => {
  function crowded(): FinancialTwin {
    const base = makeTwin();
    return {
      ...base,
      obligations: Array.from({ length: 12 }, (_, i) => ({
        ...base.obligations[0],
        id: `obl_${i}`,
        name: `A very long obligation name number ${i}`,
      })),
      goals: Array.from({ length: 6 }, (_, i) => ({
        ...base.goals[0],
        id: `goal_${i}`,
        name: `A very long goal name number ${i}`,
      })),
    };
  }

  it("places no two nodes on top of each other", () => {
    const nodes = buildIntentGraph(crowded()).nodes;
    expect(nodes.length).toBeGreaterThan(18);
    for (const a of nodes) {
      for (const b of nodes) {
        if (a.id === b.id) continue;
        const overlaps =
          Math.abs(a.position.x - b.position.x) < NODE_WIDTH &&
          Math.abs(a.position.y - b.position.y) < ROW_GAP;
        expect(overlaps, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it("puts the same twin in the same places every time", () => {
    const twin = crowded();
    const first = buildIntentGraph(twin).nodes.map((n) => [n.id, n.position.x, n.position.y]);
    const second = buildIntentGraph(twin).nodes.map((n) => [n.id, n.position.x, n.position.y]);
    expect(second).toEqual(first);
  });
});
