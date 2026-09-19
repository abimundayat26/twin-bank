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

export interface VariableSpendingDistribution {
  category: string;
  mean_14d: number;
  std_dev_14d: number;
  provenance: Provenance;
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
}

export interface ExplanationDriver {
  label: string;
  impact_amount: number;
  direction: "positive" | "negative";
  detail: string;
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
}
