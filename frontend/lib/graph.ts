/**
 * The Financial Intent Graph: a `FinancialTwin` turned into nodes and edges.
 *
 * Pure functions, no React, no DOM. React Flow types are imported for their
 * shape only (`import type`), so this module can be tested without rendering
 * anything — which matters, because React Flow measures 0x0 under jsdom.
 *
 * Nothing here derives a financial figure for display. Every label prints a
 * value straight off the contract. `monthlyEquivalent` IS a derived figure, so
 * it is confined to edge stroke width: the same licence `lib/chart.ts` takes
 * when it turns dollars into pixels. A monthly-equivalent number must never
 * reach the screen as text.
 *
 * Edges mirror what `backend/src/backend/simulation/engine.py` actually
 * simulates, not what a bank statement suggests. See `buildEdges`.
 */

import type { Edge, EdgeMarker, MarkerType, Node } from "@xyflow/react";
import { chance, longDate, money, moneyExact, ordinalDay } from "./format";
import type {
  FinancialConstraint,
  FinancialObligation,
  FinancialTwin,
  IsoDate,
  Provenance,
  SimulationEvent,
  SimulationResponse,
} from "./types";

// --- Shape -------------------------------------------------------------------

export type IntentNodeKind =
  | "income"
  | "account"
  | "obligation"
  | "spending"
  | "goal"
  | "reserve"
  | "checking_floor"
  | "purchase";

export type IntentFlag = { text: string; tone: "caution" | "info" };

/**
 * A type alias rather than an interface on purpose: React Flow's `Node<T>`
 * constrains T to `Record<string, unknown>`, and only a type alias gets the
 * implicit index signature that satisfies it.
 */
export type IntentNodeData = {
  kind: IntentNodeKind;
  title: string;
  /** The headline figure, already formatted. */
  value: string;
  hint?: string;
  provenance?: Provenance;
  flag?: IntentFlag;
};

export type IntentNode = Node<IntentNodeData, "intent">;

export interface IntentGraph {
  nodes: IntentNode[];
  edges: Edge[];
}

// --- Layout ------------------------------------------------------------------

/** Four stages: where money comes from, where it sits, where it goes, what it is for. */
export const COLUMN_X = { income: 0, account: 290, outflow: 580 } as const;

export const NODE_WIDTH = 210;

/**
 * A node is up to ~130px tall (title, figure, two-line hint and a badge), so rows
 * are spaced well clear of that. Anything tighter overlaps the moment a node
 * carries a flag.
 */
export const ROW_GAP = 150;

/**
 * Outflows wrap into further columns past this many rows.
 *
 * Alex has seven of them, and a single column that tall forces `fitView` to a zoom
 * where the labels cannot be read. Wrapping keeps the graph close to square.
 */
export const MAX_ROWS_PER_COLUMN = 4;

export const OUTFLOW_COLUMN_GAP = 240;

/** Column positions are centred on y=0, so `fitView` frames them symmetrically. */
export function columnY(index: number, count: number): number {
  return (index - (count - 1) / 2) * ROW_GAP;
}

/** How many columns `count` outflows wrap into. */
export function outflowColumns(count: number): number {
  return Math.max(1, Math.ceil(count / MAX_ROWS_PER_COLUMN));
}

/** Where the n-th outflow sits, wrapping top-to-bottom then left-to-right. */
export function outflowPosition(index: number, count: number): { x: number; y: number } {
  const columns = outflowColumns(count);
  // `count` of 0 would divide by 0 below and place the node at NaN, which React
  // Flow renders off-canvas rather than erroring.
  const perColumn = Math.max(1, Math.ceil(count / columns));
  const column = Math.floor(index / perColumn);
  const rowsInColumn = Math.min(perColumn, count - column * perColumn);
  return {
    x: COLUMN_X.outflow + column * OUTFLOW_COLUMN_GAP,
    y: columnY(index - column * perColumn, rowsInColumn),
  };
}

/** The declared column clears however many columns the outflows took. */
export function declaredX(outflowCount: number): number {
  return COLUMN_X.outflow + outflowColumns(outflowCount) * OUTFLOW_COLUMN_GAP + 60;
}

// --- Edge weight (never displayed) -------------------------------------------

export const DAYS_PER_MONTH = 30.44;

export const MIN_STROKE = 1;
export const MAX_STROKE = 5;

/**
 * A flow's size on one shared cadence, so a 14-day paycheck, a monthly bill and
 * a 14-day spending average can be compared as line thicknesses.
 *
 * Display this number nowhere. It is a derived financial figure, and the house
 * rule is that the frontend formats figures the engine produced; it does not
 * produce its own.
 */
export function monthlyEquivalent(amount: number, intervalDays: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(intervalDays) || intervalDays <= 0) return 0;
  return (amount * DAYS_PER_MONTH) / intervalDays;
}

/** Dollars per month to pixels, clamped so the thinnest flow is still visible. */
export function strokeWidthFor(monthly: number, max: number): number {
  if (!Number.isFinite(monthly) || !Number.isFinite(max) || max <= 0) return MIN_STROKE;
  const fraction = Math.min(1, Math.max(0, monthly / max));
  return MIN_STROKE + fraction * (MAX_STROKE - MIN_STROKE);
}

// --- Engine mirrors ----------------------------------------------------------

/**
 * Mirrors `engine.primary_account_id`: income, bills and everyday spending all
 * flow through the first checking account, or the first account of any type.
 *
 * The engine is the source of truth. This exists so the picture matches the
 * simulation, exactly as `lib/horizon.ts` mirrors `resolve_horizon_end`.
 */
export function primaryAccountId(twin: FinancialTwin): string | undefined {
  return (twin.accounts.find((a) => a.type === "checking") ?? twin.accounts[0])?.id;
}

/** The largest declared constraint of a type, mirroring the engine's `max(...)`. */
function largestConstraint(
  twin: FinancialTwin,
  type: FinancialConstraint["type"],
): FinancialConstraint | undefined {
  return twin.constraints
    .filter((c) => c.type === type)
    .reduce<FinancialConstraint | undefined>(
      (best, c) => (!best || c.amount > best.amount ? c : best),
      undefined,
    );
}

/** Mirrors `engine.reserve_amount`: the LARGEST declared minimum reserve wins. */
export function enforcedReserveConstraint(twin: FinancialTwin): FinancialConstraint | undefined {
  return largestConstraint(twin, "minimum_reserve");
}

/** Mirrors `engine.low_balance_threshold`: a declared checking floor beats the default. */
export function checkingFloorConstraint(twin: FinancialTwin): FinancialConstraint | undefined {
  return largestConstraint(twin, "minimum_checking_balance");
}

/**
 * Mirrors `engine.is_mandatory`: a declared category overrides the observed flag.
 *
 * Reading `obligation.mandatory` directly would label a bill Alex has declared
 * optional as mandatory, and the engine would disagree with the picture.
 */
export function isMandatory(obligation: FinancialObligation): boolean {
  if (obligation.declared_category === "bill" || obligation.declared_category === "debt_repayment")
    return true;
  if (
    obligation.declared_category === "optional_spending" ||
    obligation.declared_category === "savings_transfer"
  )
    return false;
  return obligation.mandatory;
}

/** Mirrors `engine.savings_account_id`: the first savings account, if any. */
export function savingsAccountId(twin: FinancialTwin): string | undefined {
  return twin.accounts.find((a) => a.type === "savings")?.id;
}

// --- Node builders -----------------------------------------------------------

const titleCase = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

const nodeId = (kind: IntentNodeKind, key: string) => `${kind}:${key}`;

function makeNode(id: string, x: number, y: number, data: IntentNodeData): IntentNode {
  return { id, type: "intent", position: { x, y }, data };
}

/**
 * The requested events that this twin can actually pay from, keeping each one's
 * original index so node ids stay stable.
 *
 * An event on an unknown account gets no node and no edge. Drawing the node alone
 * would leave a disconnected "Hypothetical" card floating beside the graph, and
 * the engine rejects such a request outright (`engine.validate_events`).
 */
function payableEvents(
  twin: FinancialTwin,
  simulation?: SimulationResponse | null,
): { event: SimulationEvent; index: number }[] {
  const accountIds = new Set(twin.accounts.map((a) => a.id));
  return (simulation?.request.events ?? [])
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => accountIds.has(event.account_id));
}

/**
 * The flag on the goal node, or nothing.
 *
 * `ScenarioMetrics.goal_shortfall` is the engine's SUM across every goal it
 * evaluated, so with two goals it cannot be attributed to one of them — and a
 * goal whose deadline falls past the horizon is not evaluated at all
 * (`engine.evaluate_goals`). In either case no flag is honest.
 */
export function goalFlag(
  twin: FinancialTwin,
  deadline: IsoDate,
  simulation?: SimulationResponse | null,
): IntentFlag | undefined {
  if (!simulation) return undefined;
  if (twin.goals.length !== 1) return undefined;
  if (deadline > simulation.horizon_end) return undefined;
  const { goal_shortfall: shortfall } = simulation.counterfactual;
  if (shortfall <= 0) return undefined;
  return { text: `${money(shortfall)} short`, tone: "caution" };
}

/**
 * The flag on the reserve node, or nothing.
 *
 * `prob_below_reserve` is 0 or 1 while the engine is deterministic, and becomes
 * a real fraction with Monte Carlo in Phase 4. A fraction is shown as a chance
 * rather than rounded into a confident "dips below", matching the `certainty`
 * treatment in `ScenarioComparison.tsx`.
 */
export function reserveFlag(simulation?: SimulationResponse | null): IntentFlag | undefined {
  if (!simulation) return undefined;
  const probability = simulation.counterfactual.prob_below_reserve;
  if (!(probability > 0)) return undefined;
  return {
    text: probability >= 1 ? "Dips below" : `Dips below in ${chance(probability)} of futures`,
    tone: "caution",
  };
}

/**
 * The savings-to-checking sweep, or nothing.
 *
 * `engine.sweep_from_savings` moves savings across when checking cannot cover a
 * mandatory bill on its own. It is drawn only when a simulation reports that it
 * happened, because it is a fallback the engine reaches for, not a standing
 * transfer between the accounts.
 */
export function sweepChance(simulation?: SimulationResponse | null): number {
  const probability = simulation?.counterfactual.prob_savings_sweep;
  return typeof probability === "number" && probability > 0 ? probability : 0;
}

function buildNodes(twin: FinancialTwin, simulation?: SimulationResponse | null): IntentNode[] {
  const nodes: IntentNode[] = [];

  twin.income.forEach((stream, index) => {
    nodes.push(
      makeNode(
        nodeId("income", stream.id),
        COLUMN_X.income,
        columnY(index, twin.income.length),
        {
          kind: "income",
          title: stream.source,
          value: money(stream.expected_amount),
          hint: `Every ${stream.interval_days} days · next ${longDate(stream.next_date)}`,
          provenance: stream.provenance,
        },
      ),
    );
  });

  twin.accounts.forEach((account, index) => {
    nodes.push(
      makeNode(
        nodeId("account", account.id),
        COLUMN_X.account,
        columnY(index, twin.accounts.length),
        {
          kind: "account",
          title: account.name,
          value: moneyExact(account.balance),
          hint: account.type === "checking" ? "Checking" : "Savings",
          provenance: "observed",
        },
      ),
    );
  });

  // Purchases lead the outflow column: a hypothetical belongs above the bills
  // that are actually observed.
  const events = payableEvents(twin, simulation);
  const outflowCount = events.length + twin.obligations.length + twin.variable_spending.length;
  let row = 0;
  const place = () => outflowPosition(row++, outflowCount);

  events.forEach(({ event, index }) => {
    const { x, y } = place();
    nodes.push(
      makeNode(nodeId("purchase", String(index)), x, y, {
        kind: "purchase",
        title: event.description,
        value: money(event.amount),
        hint: longDate(event.date),
        flag: { text: "Hypothetical", tone: "info" },
      }),
    );
  });

  twin.obligations.forEach((obligation) => {
    const { x, y } = place();
    nodes.push(
      makeNode(nodeId("obligation", obligation.id), x, y, {
        kind: "obligation",
        title: obligation.name,
        value: money(obligation.expected_amount),
        hint: `Due the ${ordinalDay(obligation.due_day)}`,
        provenance: obligation.provenance,
        flag: isMandatory(obligation) ? undefined : { text: "Optional", tone: "caution" },
      }),
    );
  });

  twin.variable_spending.forEach((bucket, index) => {
    const { x, y } = place();
    nodes.push(
      makeNode(nodeId("spending", String(index)), x, y, {
        kind: "spending",
        title: titleCase(bucket.category),
        value: `${money(bucket.mean_14d)} / 14d`,
        hint: `± ${money(bucket.std_dev_14d)} std dev per 14 days`,
        provenance: bucket.provenance,
      }),
    );
  });

  const reserve = enforcedReserveConstraint(twin);
  const floor = checkingFloorConstraint(twin);
  const declaredCount = twin.goals.length + (reserve ? 1 : 0) + (floor ? 1 : 0);
  const declaredColumnX = declaredX(outflowCount);
  let declaredRow = 0;

  twin.goals.forEach((goal) => {
    nodes.push(
      makeNode(
        nodeId("goal", goal.id),
        declaredColumnX,
        columnY(declaredRow++, declaredCount),
        {
          kind: "goal",
          title: goal.name,
          value: `${money(goal.current_amount)} / ${money(goal.target_amount)}`,
          hint: `by ${longDate(goal.deadline)}`,
          provenance: goal.provenance,
          flag: goalFlag(twin, goal.deadline, simulation),
        },
      ),
    );
  });

  if (reserve) {
    nodes.push(
      makeNode(
        nodeId("reserve", reserve.id),
        declaredColumnX,
        columnY(declaredRow++, declaredCount),
        {
          kind: "reserve",
          title: "Emergency reserve",
          value: money(reserve.amount),
          hint: reserve.description,
          provenance: reserve.provenance,
          flag: reserveFlag(simulation),
        },
      ),
    );
  }

  if (floor) {
    nodes.push(
      makeNode(
        nodeId("checking_floor", floor.id),
        declaredColumnX,
        columnY(declaredRow++, declaredCount),
        {
          kind: "checking_floor",
          title: "Minimum checking balance",
          value: money(floor.amount),
          hint: floor.description,
          provenance: floor.provenance,
        },
      ),
    );
  }

  return nodes;
}

// --- Edge builders -----------------------------------------------------------

/**
 * Colours are inline rather than classed on purpose: React Flow ships its own
 * stylesheet, and relying on ours to load after it would make the graph's
 * legibility a bundler-ordering accident. Inline styles win outright. The values
 * are the theme tokens from `app/globals.css`, so no new colour is introduced.
 */
const OBSERVED_STROKE = "var(--color-muted)";
const DECLARED_STROKE = "var(--color-counter)";
/** The sweep is neither a standing flow nor a declaration: it is a warning. */
const SWEEP_STROKE = "var(--color-caution)";

/** `MarkerType.ArrowClosed` without importing the enum, which is runtime code. */
const arrow = (color: string): EdgeMarker => ({
  type: "arrowclosed" as MarkerType,
  color,
  width: 16,
  height: 16,
});

function observedEdge(source: string, target: string, monthly: number, max: number): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    style: { stroke: OBSERVED_STROKE, strokeWidth: strokeWidthFor(monthly, max) },
    markerEnd: arrow(OBSERVED_STROKE),
  };
}

function declaredEdge(source: string, target: string): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    // Declared intent is not money moving. Dashed, thin, and in the
    // counterfactual colour, so it never reads as an observed flow (SPEC §2).
    style: { stroke: DECLARED_STROKE, strokeWidth: 1, strokeDasharray: "5 4" },
  };
}

/**
 * What the engine simulates, and only that:
 *
 * - every income stream credits the primary account (`primary_account_id`),
 * - every obligation and all variable spending are charged to it,
 * - a purchase is charged to its own `account_id`, which need not be that one,
 * - the reserve and the goals are measured against the TOTAL balance, so every
 *   account carries a declared edge to them.
 *
 * The one edge between accounts is the savings sweep, and only when a simulation
 * reports it happening. `engine.sweep_from_savings` moves savings into checking
 * when checking cannot cover a mandatory bill alone; nothing else in the engine
 * moves money between accounts, so nothing else is drawn between them.
 */
function buildEdges(twin: FinancialTwin, simulation?: SimulationResponse | null): Edge[] {
  const primary = primaryAccountId(twin);
  if (!primary) return [];
  const primaryNode = nodeId("account", primary);

  const flows: { source: string; target: string; monthly: number }[] = [
    ...twin.income.map((stream) => ({
      source: nodeId("income", stream.id),
      target: primaryNode,
      monthly: monthlyEquivalent(stream.expected_amount, stream.interval_days),
    })),
    ...twin.obligations.map((obligation) => ({
      source: primaryNode,
      target: nodeId("obligation", obligation.id),
      monthly: monthlyEquivalent(obligation.expected_amount, DAYS_PER_MONTH),
    })),
    ...twin.variable_spending.map((bucket, index) => ({
      source: primaryNode,
      target: nodeId("spending", String(index)),
      monthly: monthlyEquivalent(bucket.mean_14d, 14),
    })),
  ];

  // Widths are relative to the largest flow, so one column of the graph is
  // readable against another.
  const max = Math.max(0, ...flows.map((flow) => flow.monthly));
  const edges = flows.map((flow) => observedEdge(flow.source, flow.target, flow.monthly, max));

  payableEvents(twin, simulation).forEach(({ event, index }) => {
    edges.push({
      id: `${nodeId("account", event.account_id)}->${nodeId("purchase", String(index))}`,
      source: nodeId("account", event.account_id),
      target: nodeId("purchase", String(index)),
      animated: true,
      style: { stroke: DECLARED_STROKE, strokeWidth: 2 },
      markerEnd: arrow(DECLARED_STROKE),
    });
  });

  const savings = savingsAccountId(twin);
  const sweep = sweepChance(simulation);
  if (savings && savings !== primary && sweep > 0) {
    edges.push({
      id: `${nodeId("account", savings)}->${primaryNode}`,
      source: nodeId("account", savings),
      target: primaryNode,
      label: `Covers a bill in ${chance(sweep)} of futures`,
      labelStyle: { fill: "var(--color-caution)", fontSize: 11 },
      labelBgStyle: { fill: "var(--color-raised)" },
      style: { stroke: SWEEP_STROKE, strokeWidth: 1.5, strokeDasharray: "2 3" },
      markerEnd: arrow(SWEEP_STROKE),
    });
  }

  const reserve = enforcedReserveConstraint(twin);
  const floor = checkingFloorConstraint(twin);
  for (const account of twin.accounts) {
    const from = nodeId("account", account.id);
    for (const goal of twin.goals) {
      edges.push(declaredEdge(from, nodeId("goal", goal.id)));
    }
    if (reserve) edges.push(declaredEdge(from, nodeId("reserve", reserve.id)));
  }
  // The checking floor constrains one account, not the total, so only the primary
  // account carries an edge to it.
  if (floor) edges.push(declaredEdge(primaryNode, nodeId("checking_floor", floor.id)));

  return edges;
}

// --- Entry points ------------------------------------------------------------

/**
 * The graph for a twin, optionally annotated with a simulation's result.
 *
 * With no accounts there is nothing to route through, and the engine refuses to
 * simulate at all, so the graph is empty rather than a floating set of bills.
 */
export function buildIntentGraph(
  twin: FinancialTwin,
  simulation?: SimulationResponse | null,
): IntentGraph {
  if (!twin.accounts.length) return { nodes: [], edges: [] };
  return { nodes: buildNodes(twin, simulation), edges: buildEdges(twin, simulation) };
}

/**
 * One sentence describing the graph, for the container's `aria-label`.
 *
 * React Flow renders positioned divs that convey nothing in order, so without
 * this the panel is opaque to a screen reader. Mirrors the `label` that
 * `BalanceTrajectoryChart` gives its `<svg>`.
 */
/**
 * The same graph as an ordered list of stages, for readers who cannot use the canvas.
 *
 * `frontend/SPEC.md` 5.3 requires a non-canvas representation "for accessibility and
 * for screens where the complete graph would be unreadable". Built from the graph's
 * own nodes rather than from the twin a second time, so the list cannot disagree with
 * the picture beside it.
 *
 * The order is section 5.1's: accounts, then income and spending, then obligations and
 * constraints, then goals. A hypothetical purchase is its own stage, because it is not
 * a commitment and must not be listed among them.
 */
const STAGES: { title: string; kinds: IntentNodeKind[] }[] = [
  { title: "Accounts", kinds: ["account"] },
  { title: "Income and spending", kinds: ["income", "spending"] },
  { title: "Obligations and constraints", kinds: ["obligation", "reserve", "checking_floor"] },
  { title: "Goals", kinds: ["goal"] },
  { title: "Hypothetical purchase", kinds: ["purchase"] },
];

export interface IntentStage {
  title: string;
  nodes: IntentNode[];
}

export function intentStages(graph: IntentGraph): IntentStage[] {
  return STAGES.map(({ title, kinds }) => ({
    title,
    nodes: graph.nodes.filter((n) => kinds.includes(n.data.kind)),
  })).filter((stage) => stage.nodes.length > 0);
}

export function describeIntentGraph(
  twin: FinancialTwin,
  simulation?: SimulationResponse | null,
): string {
  if (!twin.accounts.length) return "No accounts to graph.";

  const primary = twin.accounts.find((a) => a.id === primaryAccountId(twin));
  const outflows = twin.obligations.length + twin.variable_spending.length;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

  const sentences = [
    `${twin.display_name}'s money: ${plural(twin.income.length, "income stream")} into ` +
      `${primary?.name ?? "the account"}, which covers ${plural(outflows, "recurring outflow")}.`,
    `${plural(twin.accounts.length, "account")} ${twin.accounts.length === 1 ? "holds" : "hold"} ` +
      `${moneyExact(twin.total_balance)} against ` +
      `${plural(twin.goals.length, "declared goal")}` +
      (enforcedReserveConstraint(twin) ? " and a declared emergency reserve." : "."),
  ];

  // The same filter the graph itself uses, so the prose cannot announce a purchase
  // that has no node: `lib/api.ts` falls back per call, so a live twin can be
  // paired with a bundled simulation whose account it does not have.
  for (const { event } of payableEvents(twin, simulation)) {
    const account = twin.accounts.find((a) => a.id === event.account_id);
    sentences.push(
      `A hypothetical ${money(event.amount)} ${event.description.toLowerCase()} is paid from ` +
        `${account?.name ?? "an account"} on ${longDate(event.date)}.`,
    );
  }
  return sentences.join(" ");
}
