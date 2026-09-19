"""Shared contracts between workstreams.

This module is the source of truth for the Financial Twin and simulation
schemas. Frontend TypeScript types must mirror it. Change it only through a
small, dedicated PR (see CLAUDE.md "Shared Contracts").

Conventions: money is USD dollars, dates are ISO 8601, probabilities are 0-1.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, computed_field, field_validator

# "observed" = derived from banking data; "declared" = stated by the user.
Provenance = Literal["observed", "declared"]
Probability = Field(ge=0, le=1)

# What a recurring obligation is for. Observed data can only suggest this;
# the user's answer is stored separately as declared_category.
ObligationCategory = Literal[
    "bill", "savings_transfer", "debt_repayment", "optional_spending", "not_recurring"
]


# What the money was for. "transfer" means money moved between accounts or to an
# unknown destination: nothing may guess that a transfer is savings, a loan
# repayment or anything else (SPEC section 2).
Category = Literal[
    "income",
    "rent",
    "utilities",
    "phone",
    "subscriptions",
    "groceries",
    "discretionary",
    "transfer",
    "other",
]


# --- Transactions -------------------------------------------------------------


class Transaction(BaseModel):
    """One normalized transaction: signed, categorized, ready to analyze.

    The input to twin building, so it is a shared contract. The raw, per-provider
    shape it comes from stays in `backend.ingest.models`.
    """

    id: str
    account_id: str
    date: date
    amount: float = Field(description="Signed: positive is money in, negative is money out.")
    description: str
    category: Category
    provenance: Literal["observed"] = "observed"


# --- Financial Twin -----------------------------------------------------------


class Account(BaseModel):
    id: str
    name: str
    type: Literal["checking", "savings"]
    balance: float


class IncomeStream(BaseModel):
    id: str
    source: str
    expected_amount: float = Field(gt=0)
    interval_days: int = Field(gt=0)
    next_date: date
    uncertainty: float = Field(ge=0, description="Standard deviation per payment, USD.")
    provenance: Provenance = "observed"


class CategoryCandidate(BaseModel):
    category: ObligationCategory
    probability: float = Probability


class FinancialObligation(BaseModel):
    id: str
    name: str
    expected_amount: float = Field(gt=0)
    due_day: int = Field(ge=1, le=31, description="Day of month the obligation is due.")
    mandatory: bool = True
    confidence: float = Probability
    provenance: Provenance = "observed"
    category_candidates: list[CategoryCandidate] = Field(
        default=[],
        description="Likely categories, most likely first. Non-empty means the app should "
        "ask the user which one applies.",
    )
    declared_category: ObligationCategory | None = Field(
        default=None, description="The user's answer to the category question."
    )

    @field_validator("category_candidates")
    @classmethod
    def check_candidates(cls, candidates: list[CategoryCandidate]) -> list[CategoryCandidate]:
        categories = [c.category for c in candidates]
        if len(set(categories)) != len(categories):
            raise ValueError("category candidates must not repeat a category")
        probabilities = [c.probability for c in candidates]
        if probabilities != sorted(probabilities, reverse=True):
            raise ValueError("category candidates must be ordered most likely first")
        if sum(probabilities) > 1 + 1e-9:
            raise ValueError("category candidate probabilities must sum to at most 1")
        return candidates


class VariableSpendingDistribution(BaseModel):
    category: str
    mean_14d: float = Field(ge=0)
    std_dev_14d: float = Field(ge=0)
    provenance: Provenance = "observed"


class Goal(BaseModel):
    id: str
    name: str
    target_amount: float = Field(gt=0)
    deadline: date
    current_amount: float = Field(default=0, ge=0)
    provenance: Literal["declared"] = "declared"


class FinancialConstraint(BaseModel):
    id: str
    # minimum_reserve: checking plus savings. minimum_checking_balance: checking only,
    # the user's own low-balance line.
    type: Literal["minimum_reserve", "minimum_checking_balance"]
    amount: float = Field(ge=0)
    description: str
    provenance: Literal["declared"] = "declared"


class FinancialTwin(BaseModel):
    user_id: str
    display_name: str
    as_of: date
    accounts: list[Account]
    income: list[IncomeStream]
    obligations: list[FinancialObligation]
    variable_spending: list[VariableSpendingDistribution]
    goals: list[Goal]
    constraints: list[FinancialConstraint]

    @computed_field
    @property
    def total_balance(self) -> float:
        return round(sum(a.balance for a in self.accounts), 2)


# --- Twin updates ------------------------------------------------------------


class ClarificationResponseRequest(BaseModel):
    user_id: str
    obligation_id: str
    category: ObligationCategory


class MinimumBalanceRequest(BaseModel):
    amount: float = Field(ge=0)


class TwinBuildRequest(BaseModel):
    """Build a twin's observed structure from the user's transaction history.

    Only the observed half can be built. Goals and constraints are declared by
    the user and are carried over from the twin already on file, never derived
    (SPEC section 2). Balances cannot come from a transaction feed either, so
    `accounts` is an input: omitted, the accounts on file are kept.
    """

    user_id: str
    as_of: date | None = Field(
        default=None, description="Defaults to the date of the latest transaction."
    )
    accounts: list[Account] | None = Field(
        default=None, description="Current balances. Defaults to the accounts on file."
    )


# --- Simulation ---------------------------------------------------------------


class SimulationEvent(BaseModel):
    type: Literal["purchase"]
    description: str
    amount: float = Field(gt=0)
    date: date
    account_id: str


class SimulationRequest(BaseModel):
    user_id: str
    events: list[SimulationEvent] = Field(min_length=1)
    horizon_end: date | None = Field(
        default=None, description="Defaults to the earliest goal deadline."
    )


class ScenarioMetrics(BaseModel):
    ending_balance: float
    min_balance: float
    prob_low_balance: float = Probability
    prob_below_reserve: float = Probability
    goal_shortfall: float = Field(ge=0, description="USD short of the goal at its deadline.")
    obligations_covered: bool
    prob_obligations_uncovered: float | None = Field(
        default=None,
        ge=0,
        le=1,
        description="Share of simulated futures where checking misses a mandatory bill. "
        "None when not computed (mock results).",
    )
    prob_goal_met: float | None = Field(
        default=None,
        ge=0,
        le=1,
        description="Share of simulated futures meeting every goal due within the horizon. "
        "None when not computed or no goal is due within the horizon.",
    )
    prob_savings_sweep: float | None = Field(
        default=None,
        ge=0,
        le=1,
        description="Share of simulated futures where checking could not cover a mandatory "
        "bill on its own and savings had to make up the difference. The bill was still "
        "paid; see prob_obligations_uncovered for the futures where it was not. "
        "None when not computed (mock results).",
    )


class ExplanationDriver(BaseModel):
    label: str
    impact_amount: float
    direction: Literal["positive", "negative"]
    detail: str


class SimulationResponse(BaseModel):
    simulation_id: str
    user_id: str
    request: SimulationRequest
    horizon_end: date
    baseline: ScenarioMetrics
    counterfactual: ScenarioMetrics
    summary: str
    drivers: list[ExplanationDriver]
    assumptions: list[str]
    is_mock: bool
    num_simulations: int | None = Field(
        default=None, ge=1, description="Monte Carlo runs behind the metrics. None for mock results."
    )
