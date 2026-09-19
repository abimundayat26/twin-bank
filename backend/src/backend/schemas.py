"""Shared contracts between workstreams.

This module is the source of truth for the Financial Twin and simulation
schemas. Frontend TypeScript types must mirror it. Change it only through a
small, dedicated PR (see CLAUDE.md "Shared Contracts").

Conventions: money is USD dollars, dates are ISO 8601, probabilities are 0-1.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, computed_field

# "observed" = derived from banking data; "declared" = stated by the user.
Provenance = Literal["observed", "declared"]
Probability = Field(ge=0, le=1)


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


class FinancialObligation(BaseModel):
    id: str
    name: str
    expected_amount: float = Field(gt=0)
    due_day: int = Field(ge=1, le=31, description="Day of month the obligation is due.")
    mandatory: bool = True
    confidence: float = Probability
    provenance: Provenance = "observed"


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
    type: Literal["minimum_reserve"]
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
