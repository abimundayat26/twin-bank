/**
 * Mirror of `backend/src/backend/schemas.py`, which is the source of truth for
 * these contracts. If a field changes there, change it here in the same PR.
 *
 * Conventions: money is USD dollars, dates are ISO 8601 `YYYY-MM-DD`,
 * probabilities are 0-1.
 */

/** "observed" = derived from banking data; "declared" = stated by the user. */
export type Provenance = "observed" | "declared";

export type IsoDate = string;

/**
 * What the money was for. "transfer" means money moved to an unknown
 * destination: nothing may guess that a transfer is savings or a repayment.
 */
export type Category =
  | "income"
  | "rent"
  | "utilities"
  | "phone"
  | "subscriptions"
  | "groceries"
  | "discretionary"
  | "transfer"
  | "other";

// --- Transactions -----------------------------------------------------------

/** One normalized transaction: signed, categorized, ready to analyze. */
export interface Transaction {
  id: string;
  account_id: string;
  date: IsoDate;
  /** Signed: positive is money in, negative is money out. */
  amount: number;
  description: string;
  category: Category;
  provenance: "observed";
}

// --- Financial Twin ---------------------------------------------------------

export interface Account {
  id: string;
  name: string;
  type: "checking" | "savings";
  balance: number;
}

export interface IncomeStream {
  id: string;
  source: string;
  expected_amount: number;
  interval_days: number;
  next_date: IsoDate;
  /** Standard deviation per payment, USD. */
  uncertainty: number;
  provenance: Provenance;
}

/** What a recurring obligation is for. The user's answer is `declared_category`. */
export type ObligationCategory =
  | "bill"
  | "savings_transfer"
  | "debt_repayment"
  | "optional_spending"
  | "not_recurring";

export interface CategoryCandidate {
  category: ObligationCategory;
  probability: number;
}

export interface FinancialObligation {
  id: string;
  name: string;
  expected_amount: number;
  /** Day of month the obligation is due. */
  due_day: number;
  /** Explicitly supplied by the user; the compiler must not invent this status. */
  mandatory: boolean;
  confidence: number;
  provenance: Provenance;
  /** Likely categories, most likely first. Non-empty means ask the user. */
  category_candidates?: CategoryCandidate[];
  /** The user's answer to the category question. */
  declared_category?: ObligationCategory | null;
  /**
   * False means paused: the simulator and the overview ignore it. A twin saved
   * before this field existed loads as active.
   */
  active?: boolean;
}

/**
 * How a category's spending moves around the year. `factors` maps calendar month to a
 * multiplier on both `mean_14d` and `std_dev_14d`: a busy month is proportionally more
 * variable, not just larger.
 *
 * The factors are mean-preserving — the twelve average to 1.0 — so `mean_14d` still means
 * the annual-average fortnight. The keys are the months 1-12, as strings, because that is
 * how JSON carries them.
 */
export interface SeasonalProfile {
  factors: Record<string, number>;
}

export interface VariableSpendingDistribution {
  category: string;
  mean_14d: number;
  std_dev_14d: number;
  provenance: Provenance;
  /** Per-month shape. Absent/null means a flat mean and spread across the year. */
  seasonal?: SeasonalProfile | null;
}

export interface Goal {
  id: string;
  name: string;
  target_amount: number;
  deadline: IsoDate;
  current_amount: number;
  provenance: "declared";
}

/**
 * A known future expense that happens once: tuition, a deposit, an annual premium.
 *
 * Deliberately not a `FinancialObligation`. That one recurs on a day of the month;
 * this one has a single absolute date and must never repeat.
 *
 * Always declared — the user tells TwinBank about it, and it reaches the twin only
 * after they confirm the draft. A confirmed one belongs to the *baseline* future: it
 * is a commitment already made, not a hypothetical purchase being simulated.
 */
export interface OneTimeObligation {
  id: string;
  name: string;
  /** Always a withdrawal, so the sign is implied. */
  amount: number;
  /** The one absolute date it is paid. It does not repeat. */
  due_date: IsoDate;
  /** The account it is paid from. */
  account_id: string;
  mandatory: boolean;
  provenance: "declared";
}

export interface FinancialConstraint {
  id: string;
  /** minimum_reserve: checking plus savings. minimum_checking_balance: checking only. */
  type: "minimum_reserve" | "minimum_checking_balance";
  amount: number;
  description: string;
  provenance: "declared";
}

/**
 * Where the twin's observed figures came from: which method produced them, over what
 * window, and how heavily it weighted recent fortnights. Describes the estimate, not
 * the future.
 */
export interface ForecastMetadata {
  /**
   * flat_mean: every observed fortnight weighted equally, no seasonality.
   * seasonal_ewma: recency-weighted, with a per-month seasonal profile.
   */
  method: "flat_mean" | "seasonal_ewma";
  /** Last day of observed data behind the estimate. */
  as_of: IsoDate;
  /**
   * First day of the fitted window: the start of the oldest whole fortnight
   * behind the estimate. Records older than this exist but were not fitted to,
   * so window_start to as_of always divides into observed_fortnights.
   */
  window_start: IsoDate;
  /** 14-day blocks the estimate is fitted to. */
  observed_fortnights: number;
  /** Days after which an observation carries half the weight. Absent/null when equally weighted. */
  half_life_days?: number | null;
}

/**
 * Where and when the pipeline that produced this twin ran.
 *
 * Identifiers and status only. SPEC section 3.5 forbids any secret, token,
 * private connection value or raw environment configuration reaching the
 * browser, so the backend model has no free-text field a credential could be
 * pasted into and rejects unknown keys. A host, workspace URL, volume path or
 * experiment name is deliberately absent: the user is told where the work ran,
 * not how to reach it.
 */
export interface ProcessingLineage {
  /** Where the pipeline ran. "local" is the backend process itself. */
  location: "local" | "databricks";
  /**
   * How the run that produced this twin finished. "unknown" when the producer
   * cannot tell — a served twin whose job status was never read.
   */
  status: "succeeded" | "failed" | "unknown";
  /**
   * MLflow run that recorded this build: 32 lowercase hex characters, MLflow's
   * own format. Absent/null when tracking was off.
   */
  mlflow_run_id?: string | null;
  /** ISO 8601 timestamp of that run. Absent/null when it was not recorded. */
  run_time?: string | null;
}

export interface FinancialTwin {
  user_id: string;
  display_name: string;
  as_of: IsoDate;
  accounts: Account[];
  income: IncomeStream[];
  obligations: FinancialObligation[];
  variable_spending: VariableSpendingDistribution[];
  goals: Goal[];
  constraints: FinancialConstraint[];
  /**
   * Known one-off future expenses the user declared and confirmed. Absent on a twin
   * from a backend that predates the contract, so read it through
   * `oneTimeObligations()` in `lib/twin.ts` rather than indexing it directly.
   */
  one_time_obligations?: OneTimeObligation[];
  /** How the observed figures were estimated. Absent/null when not recorded. */
  forecast?: ForecastMetadata | null;
  /**
   * Where the observed half came from. Absent on a twin the backend did not
   * load from a source, and on the offline mock.
   */
  source?: "fixture" | "nessie" | "databricks" | null;
  /**
   * How the twin was produced, as opposed to where its data came from: the two
   * are separate facts and a twin can carry either without the other.
   * Absent/null when nothing recorded it, which the UI must show as unavailable
   * rather than guessing (SPEC section 3.5).
   */
  lineage?: ProcessingLineage | null;
  /** Computed server-side; present in the JSON payload. */
  total_balance: number;
}

// --- Twin updates -----------------------------------------------------------

export interface ClarificationResponseRequest {
  user_id: string;
  obligation_id: string;
  category: ObligationCategory;
}

export interface MinimumBalanceRequest {
  amount: number;
}

/**
 * Rebuild a twin's observed structure from the user's transaction history.
 * Goals and constraints are declared, so they are carried over, never derived.
 */
export interface TwinBuildRequest {
  user_id: string;
  /** Defaults to the date of the latest transaction. */
  as_of?: IsoDate | null;
  /** Current balances. Defaults to the accounts on file. */
  accounts?: Account[] | null;
}

// --- Simulation -------------------------------------------------------------

export interface SimulationEvent {
  type: "purchase";
  description: string;
  amount: number;
  date: IsoDate;
  account_id: string;
}

export interface SimulationRequest {
  user_id: string;
  events: SimulationEvent[];
  /** Defaults server-side to the earliest goal deadline. */
  horizon_end?: IsoDate | null;
}

export interface ScenarioMetrics {
  ending_balance: number;
  min_balance: number;
  prob_low_balance: number;
  prob_below_reserve: number;
  /** USD short of the goal at its deadline. */
  goal_shortfall: number;
  obligations_covered: boolean;
  /** Share of simulated futures where checking misses a mandatory bill. Absent/null on mock results. */
  prob_obligations_uncovered?: number | null;
  /** Share of simulated futures meeting every goal due within the horizon. Absent/null if not computed. */
  prob_goal_met?: number | null;
  /**
   * Share of simulated futures where checking could not cover a mandatory bill on its
   * own and savings made up the difference. The bill was still paid — see
   * prob_obligations_uncovered for the futures where it was not. Absent/null on mock results.
   */
  prob_savings_sweep?: number | null;
}

export interface ExplanationDriver {
  label: string;
  impact_amount: number;
  direction: "positive" | "negative";
  detail: string;
}

/** One day's spread of a balance across simulated futures. */
export interface BalanceBandPoint {
  date: IsoDate;
  p10: number;
  median: number;
  p90: number;
}

/** End-of-day balances per day, from as_of through horizon_end. */
export interface ScenarioBands {
  /** Checking plus savings. */
  total: BalanceBandPoint[];
  checking: BalanceBandPoint[];
}

export interface BalanceBands {
  baseline: ScenarioBands;
  counterfactual: ScenarioBands;
}

export interface SimulationResponse {
  simulation_id: string;
  user_id: string;
  request: SimulationRequest;
  horizon_end: IsoDate;
  baseline: ScenarioMetrics;
  counterfactual: ScenarioMetrics;
  summary: string;
  drivers: ExplanationDriver[];
  assumptions: string[];
  is_mock: boolean;
  /** Monte Carlo runs behind the metrics. Absent/null on mock results. */
  num_simulations?: number | null;
  /** Daily p10/median/p90 balances for charts. Absent/null when not computed. */
  balance_bands?: BalanceBands | null;
}

// --- Optimization -----------------------------------------------------------

export type CandidateKind = "buy_now" | "delay" | "reduce_spending" | "from_savings";

export interface OptimizationRequest {
  user_id: string;
  events: SimulationEvent[];
  /** Defaults server-side to the earliest goal deadline. */
  horizon_end?: IsoDate | null;
}

export interface SpendingAdjustment {
  category: string;
  /** 0-1. Scales the category's mean and spread for the whole horizon. */
  multiplier: number;
}

export interface OptimizationCandidate {
  id: string;
  kind: CandidateKind;
  label: string;
  detail: string;
  /** The purchase as this action makes it. */
  events: SimulationEvent[];
  spending_adjustments: SpendingAdjustment[];
  metrics: ScenarioMetrics;
  meets_constraints: boolean;
  /** Declared hard constraints this action breaks, in words. */
  violations: string[];
}

export interface OptimizationResponse {
  optimization_id: string;
  user_id: string;
  request: OptimizationRequest;
  horizon_end: IsoDate;
  /** The future without the purchase. */
  baseline: ScenarioMetrics;
  /** Best first. */
  candidates: OptimizationCandidate[];
  /** Best candidate that meets every hard constraint. Null when none does. */
  recommended_id: string | null;
  summary: string;
  assumptions: string[];
  /** Monte Carlo runs behind each candidate. */
  num_simulations: number;
}

// --- Goal compiler ------------------------------------------------------------

/**
 * "type": a goal or a standing reserve. "account": which account pays a one-time
 * obligation. "intent": the text could be a goal or a declared obligation and the
 * Assistant must ask rather than choose. "mandatory": the user must explicitly
 * classify a one-time obligation as mandatory or optional.
 */
export type GoalClarificationField =
  | "amount"
  | "deadline"
  | "name"
  | "type"
  | "account"
  | "intent"
  | "mandatory";

export interface GoalCompileRequest {
  user_id: string;
  /** 1-2000 characters. */
  text: string;
}

export interface GoalClarification {
  /** What is missing or ambiguous. */
  field: GoalClarificationField;
  question: string;
  /** The part of the text the question is about. */
  fragment: string;
}

/**
 * A category the user stated in words for an obligation TwinBank detected.
 *
 * A draft, like everything else the compiler returns. Read it back and confirm it
 * through `POST /clarifications/respond`; nothing here has been declared.
 */
export interface ObligationClassificationDraft {
  obligation_id: string;
  /** As shown to the user, so it can be read back. */
  obligation_name: string;
  category: ObligationCategory;
  /** The part of the text this came from. */
  fragment: string;
}

/** Drafts only: nothing is saved until the user confirms them. */
export interface GoalCompileResponse {
  user_id: string;
  text: string;
  goals: Goal[];
  constraints: FinancialConstraint[];
  /**
   * Drafted one-off expenses the user says they already owe. Absent from a backend
   * that predates the contract, so read it as "none drafted", never as an error.
   */
  one_time_obligations?: OneTimeObligation[];
  /**
   * Answers about already-detected recurring obligations, read back for confirmation
   * rather than applied. Absent from a backend that predates the contract.
   */
  classifications?: ObligationClassificationDraft[];
  /**
   * Asked instead of guessing. A goal or obligation missing a detail is not drafted
   * at all.
   */
  clarifications: GoalClarification[];
  /** Parts of the text that matched nothing. */
  unparsed: string[];
  compiler: "rules" | "llm";
}

/**
 * Replaces the user's goals and emergency reserve. A minimum_checking_balance here
 * sets the same value as PUT /twin/{user_id}/minimum-balance.
 */
export interface DeclaredGoalsRequest {
  goals: Goal[];
  constraints?: FinancialConstraint[];
  /**
   * Confirmed one-off expenses. Omitted keeps the ones already confirmed; an empty
   * list clears them.
   */
  one_time_obligations?: OneTimeObligation[] | null;
}

/**
 * What the simulator treats as a low checking balance when the user has not declared a
 * minimum_checking_balance constraint of their own. Mirrors LOW_BALANCE_THRESHOLD in
 * backend/src/backend/simulation/engine.py — change both together.
 *
 * Only for telling the user what the default is. Every displayed result already has the
 * threshold applied server-side; never re-derive a low-balance verdict from this.
 */
export const DEFAULT_LOW_BALANCE_THRESHOLD = 200;

/*
 * Everything below mirrors the contracts added for the minimalist layout
 * (frontend/SPEC.md section 4). Section numbers in the comments refer to that
 * document. Additive only: nothing above changed.
 */

// --- Overview ----------------------------------------------------------------

/** An account as the Overview page lists it: no transactions, no history. */
export interface OverviewAccount {
  id: string;
  name: string;
  balance: number;
}

/**
 * One wedge of the spending donut. `label` is a variable-spending category,
 * "Fixed bills", or "Other": obligations carry no category of spend, so TwinBank
 * groups them rather than guessing one.
 */
export interface SpendingSlice {
  label: string;
  monthly_amount: number;
}

export interface UpcomingItem {
  name: string;
  /** Signed: positive is income, negative is an outflow. */
  amount: number;
  date: IsoDate;
  kind: "income" | "recurring_bill" | "one_time_bill";
}

/** GET /twin/{user_id}/overview (OV-1). */
export interface OverviewPayload {
  user_id: string;
  as_of: IsoDate;
  total_balance: number;
  monthly_net_cash_flow: number;
  /** 0-1. Null when the twin has no goals. */
  goal_progress?: number | null;
  accounts: OverviewAccount[];
  /** At most four categories plus "Other" (OV-5). */
  spending?: SpendingSlice[];
  total_monthly_spending: number;
  /** At most five, ascending by date (OV-7). */
  upcoming?: UpcomingItem[];
}

// --- Obligations management --------------------------------------------------

/**
 * One answer the user may pick for an unclear obligation. Deliberately carries no
 * probability: the page shows plain words in likelihood order, never a confidence
 * number (G-5).
 */
export interface CategoryOption {
  category: ObligationCategory;
  label: string;
}

/** A recurring obligation as the Obligations page lists it (OB-1). */
export interface RecurringObligationRow {
  id: string;
  name: string;
  amount: number;
  /** FinancialObligation is keyed on due_day only. */
  frequency?: "monthly";
  due_day: number;
  active: boolean;
  /** detected = rebuilt from transactions, so it can be paused but not deleted. */
  origin: "detected" | "declared";
  /** The declared category in words, null when undeclared. */
  category_label?: string | null;
  /** Candidates exist and the user has not declared one. */
  needs_answer: boolean;
  /** Most likely first, without probabilities. */
  options?: CategoryOption[];
}

/** A one-off expense as the Obligations page lists it (OB-1). */
export interface OneTimeObligationRow {
  id: string;
  name: string;
  amount: number;
  due_date: IsoDate;
  account_id: string;
  account_name: string;
  mandatory: boolean;
}

export interface ObligationsPayload {
  user_id: string;
  as_of: IsoDate;
  recurring?: RecurringObligationRow[];
  /** Only those still ahead: due_date > as_of. */
  one_time?: OneTimeObligationRow[];
}

/** POST body. Anything the user types is declared, never detected (PER-3). */
export interface RecurringObligationCreate {
  name: string;
  amount: number;
  due_day: number;
  mandatory?: boolean;
}

/** PUT body. An omitted field is unchanged; at least one must be given. */
export interface RecurringObligationChanges {
  name?: string;
  amount?: number;
  due_day?: number;
  active?: boolean;
}

/** POST body. The route additionally checks the date against the twin's as_of. */
export interface OneTimeObligationCreate {
  name: string;
  amount: number;
  due_date: IsoDate;
  account_id: string;
  mandatory?: boolean;
}

/** PUT body. An omitted field is unchanged; at least one must be given. */
export interface OneTimeObligationChanges {
  name?: string;
  amount?: number;
  due_date?: IsoDate;
  account_id?: string;
  mandatory?: boolean;
}

// --- Goal and limit edits ----------------------------------------------------

/**
 * PATCH body for one goal (PL-10). A partial edit, so a stale client cannot
 * overwrite the user's other goals the way the replace-all PUT /goals would.
 */
export interface GoalChanges {
  name?: string;
  target_amount?: number;
  deadline?: IsoDate;
  current_amount?: number;
}

/** PUT /twin/{user_id}/reserve (PL-9). Zero removes the reserve. */
export interface ReserveRequest {
  amount: number;
}

// --- Forecast view -----------------------------------------------------------

/**
 * A high or low point worth naming on the Forecast page. `label` is built from a
 * fixed template vocabulary and the twin's own content (FD-9); a model never
 * writes it.
 */
export interface ForecastCallout {
  date: IsoDate;
  kind: "peak" | "trough";
  balance: number;
  label: string;
}

/** GET /twin/{user_id}/forecast (FD-6): the baseline /simulate cannot give. */
export interface ForecastPayload {
  user_id: string;
  horizon_end: IsoDate;
  bands: ScenarioBands;
  callouts?: ForecastCallout[];
  num_simulations?: number | null;
  is_mock?: boolean;
}

// --- Committing a purchase ---------------------------------------------------

/** Moving a goal's deadline as part of committing a purchase (CM-4). */
export interface GoalDateChange {
  goal_id: string;
  /** The deadline the client saw. A mismatch is a 409, not an overwrite. */
  from_deadline: IsoDate;
  /** The new, later deadline. */
  deadline: IsoDate;
}

/** POST /twin/{user_id}/purchases/commit (CM-3). One purchase in v1. */
export interface CommitPurchaseRequest {
  events: SimulationEvent[];
  goal_updates?: GoalDateChange[];
}

export interface CommitPurchaseResponse {
  twin: FinancialTwin;
  /** The one-time obligation ids now on the twin. */
  created_ids?: string[];
  /** True when this exact purchase was already there (G-15). */
  already_committed?: boolean;
}

/** POST /twin/{user_id}/goals/{goal_id}/earliest-date (CM-2). */
export interface EarliestDateRequest {
  events: SimulationEvent[];
}

export interface EarliestDateResponse {
  goal_id: string;
  original_deadline: IsoDate;
  /** Null when no date inside the 730-day limit restores the chance. */
  earliest_deadline?: IsoDate | null;
  baseline_prob_goal_met?: number | null;
  prob_goal_met_at_earliest?: number | null;
  searched_until: IsoDate;
}

// --- Assistant ---------------------------------------------------------------
//
// The Assistant only ever drafts. Nothing here changes the twin: a proposal does
// that through POST /assistant/proposals/{id}/decision with "accept" (AS-1, AS-15).

export type AssistantAction =
  | "ADD_GOAL"
  | "UPDATE_GOAL"
  | "ADD_OBLIGATION"
  | "UPDATE_OBLIGATION"
  | "SET_CONSTRAINT"
  | "CLASSIFY_OBLIGATION";

export interface ProposalBase {
  proposal_id: string;
  status?: "pending" | "accepted" | "rejected";
  /**
   * The user's own words this came from. A quote the frontend can check against
   * the message, where a model's "reasoning" could not be (V1).
   */
  source_fragment: string;
  requires_user_confirmation?: true;
}

export interface AddGoalProposal extends ProposalBase {
  action_type: "ADD_GOAL";
  goal: Goal;
}

export interface UpdateGoalProposal extends ProposalBase {
  action_type: "UPDATE_GOAL";
  goal_id: string;
  /** As shown on the card, so the user can read it back. */
  goal_name: string;
  changes: GoalChanges;
}

/** One-time obligations only in v1. A recurring one is added on /obligations. */
export interface AddObligationProposal extends ProposalBase {
  action_type: "ADD_OBLIGATION";
  obligation: OneTimeObligation;
}

export interface UpdateObligationProposal extends ProposalBase {
  action_type: "UPDATE_OBLIGATION";
  obligation_id: string;
  obligation_name: string;
  kind: "recurring" | "one_time";
  recurring_changes?: RecurringObligationChanges | null;
  one_time_changes?: OneTimeObligationChanges | null;
}

export interface SetConstraintProposal extends ProposalBase {
  action_type: "SET_CONSTRAINT";
  constraint: FinancialConstraint;
}

/** Answering "the $50 transfer is savings" about a detected obligation (AS-7). */
export interface ClassifyObligationProposal extends ProposalBase {
  action_type: "CLASSIFY_OBLIGATION";
  classification: ObligationClassificationDraft;
}

/** Discriminated on `action_type`, exactly as the backend union is. */
export type Proposal =
  | AddGoalProposal
  | UpdateGoalProposal
  | AddObligationProposal
  | UpdateObligationProposal
  | SetConstraintProposal
  | ClassifyObligationProposal;

/** Asked instead of guessing. The text comes from a template (8.3), never a model. */
export interface AssistantQuestion {
  question_id: string;
  text: string;
  field: GoalClarificationField | "which_one" | "category";
  /** Quick replies. Empty means free text. */
  choices?: string[];
  fragment: string;
}

/** A what-if, handed to the Purchase Simulator filled in but not run (AS-8). */
export interface SimulatePrefill {
  description: string;
  amount: number;
  date?: IsoDate | null;
}

export interface AssistantMessageRequest {
  user_id: string;
  text: string;
  conversation_id?: string | null;
  /**
   * The message_id of the question being answered. Sent only when the user answers
   * a specific question; the backend never guesses (AS-11).
   */
  in_reply_to?: string | null;
}

export interface AssistantMessageResponse {
  conversation_id: string;
  message_id: string;
  /** Always from a template in 8.3, never a model's words (AS-3). */
  reply: string;
  /** Who read the user's words: compiler "rules" maps to "rules", "llm" to "model" (AS-4). */
  read_by: "rules" | "model";
  /** At most five (AS-17). */
  proposals?: Proposal[];
  /** At most three (AS-17). */
  questions?: AssistantQuestion[];
  simulate_prefill?: SimulatePrefill | null;
  unparsed?: string[];
}

/** GET /assistant/opening/{user_id} (AS-9). Empty when nothing is unclassified. */
export interface AssistantOpening {
  questions?: AssistantQuestion[];
}

export interface ProposalDecisionRequest {
  decision: "accept" | "reject";
}

export interface ProposalDecisionResponse {
  proposal_id: string;
  status: "accepted" | "rejected";
  /** The updated twin on accept, null on reject. */
  twin?: FinancialTwin | null;
}
