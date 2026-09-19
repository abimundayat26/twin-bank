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
  mandatory: boolean;
  confidence: number;
  provenance: Provenance;
  /** Likely categories, most likely first. Non-empty means ask the user. */
  category_candidates?: CategoryCandidate[];
  /** The user's answer to the category question. */
  declared_category?: ObligationCategory | null;
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
  /** First day of observed data behind the estimate. */
  window_start: IsoDate;
  /** 14-day blocks the estimate is fitted to. */
  observed_fortnights: number;
  /** Days after which an observation carries half the weight. Absent/null when equally weighted. */
  half_life_days?: number | null;
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
  /** How the observed figures were estimated. Absent/null when not recorded. */
  forecast?: ForecastMetadata | null;
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

export type GoalClarificationField = "amount" | "deadline" | "name" | "type";

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

/** Drafts only: nothing is saved until the user confirms them. */
export interface GoalCompileResponse {
  user_id: string;
  text: string;
  goals: Goal[];
  constraints: FinancialConstraint[];
  /** Asked instead of guessing. A goal missing a detail is not in goals. */
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
