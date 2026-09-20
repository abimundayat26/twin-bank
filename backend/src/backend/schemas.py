"""Shared contracts between workstreams.

This module is the source of truth for the Financial Twin and simulation
schemas. Frontend TypeScript types must mirror it. Change it only through a
small, dedicated PR (see CLAUDE.md "Shared Contracts").

Conventions: money is USD dollars, dates are ISO 8601, probabilities are 0-1.
"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator

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


class OneTimeObligation(BaseModel):
    """A known future expense that happens once: tuition, a deposit, an annual premium.

    Deliberately not a `FinancialObligation`. That one is keyed on `due_day`, a day of
    the month, and the engine expands it through `monthly_due_dates()` -- a single
    absolute date has no place in recurrence logic, and squeezing it in there would be
    the easiest way to corrupt it.

    Always declared: the user tells TwinBank about this, it is never inferred from
    transactions (SPEC section 2), and it only reaches the twin after the user confirms
    the draft. A confirmed one belongs to the *baseline* future -- it is a commitment
    already made, not a hypothetical purchase being simulated.
    """

    id: str
    name: str
    amount: float = Field(gt=0, description="Always a withdrawal, so the sign is implied.")
    due_date: date = Field(description="The one absolute date it is paid. It does not repeat.")
    account_id: str = Field(description="The account it is paid from.")
    mandatory: bool = Field(
        description="Whether missing this payment would violate a commitment the user marked mandatory."
    )
    provenance: Literal["declared"] = "declared"


class SeasonalProfile(BaseModel):
    """How a category's spending moves around the year.

    `factors` maps calendar month (1-12) to a multiplier on both `mean_14d` and
    `std_dev_14d`: a busy month is proportionally more variable, not just larger.

    The factors are mean-preserving — the twelve average to 1.0 — so `mean_14d`
    still means the annual-average fortnight. Attaching a profile therefore moves
    nothing that reads `mean_14d` today; it only says how that average is spread
    across the year.

    JSON serializes the int keys as strings ("1".."12"); parsing coerces them back.
    """

    factors: dict[int, float] = Field(
        description="Calendar month (1-12) to a multiplier on mean_14d and std_dev_14d."
    )

    @field_validator("factors")
    @classmethod
    def check_factors(cls, factors: dict[int, float]) -> dict[int, float]:
        if set(factors) != set(range(1, 13)):
            raise ValueError("seasonal factors must cover every calendar month 1-12 exactly once")
        if any(factor < 0 for factor in factors.values()):
            raise ValueError("seasonal factors must not be negative")
        mean = sum(factors.values()) / 12
        if abs(mean - 1) > 0.01:
            raise ValueError("seasonal factors must average 1.0, so that mean_14d is preserved")
        return factors


class VariableSpendingDistribution(BaseModel):
    category: str
    mean_14d: float = Field(ge=0)
    std_dev_14d: float = Field(ge=0)
    provenance: Provenance = "observed"
    seasonal: SeasonalProfile | None = Field(
        default=None,
        description="Per-month shape of this category's spending. None means the mean and "
        "spread are treated as flat across the year.",
    )


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


class ForecastMetadata(BaseModel):
    """Where the twin's spending and income figures came from.

    Describes the estimate, not the future: which method produced the numbers on
    this twin, over what window, and how heavily it weighted recent fortnights.
    """

    method: Literal["flat_mean", "seasonal_ewma"] = Field(
        description="flat_mean: every observed fortnight weighted equally, no seasonality. "
        "seasonal_ewma: recency-weighted, with a per-month seasonal profile."
    )
    as_of: date = Field(description="Last day of observed data behind the estimate.")
    window_start: date = Field(
        description="First day of the fitted window: the start of the oldest whole "
        "fortnight behind the estimate. Records older than this exist but were not "
        "fitted to, so window_start to as_of always divides into observed_fortnights."
    )
    observed_fortnights: int = Field(ge=0, description="14-day blocks the estimate is fitted to.")
    half_life_days: float | None = Field(
        default=None,
        gt=0,
        description="Days after which an observation carries half the weight. "
        "None when the method weights every observation equally.",
    )


class ProcessingLineage(BaseModel):
    """Where and when the pipeline that produced this twin ran.

    Identifiers and status only. `frontend/SPEC.md` section 3.5 renders this on
    the Forecast & Data page and forbids any secret, token, private connection
    value or raw environment configuration reaching the browser, so this model
    is built so that none can be put in it in the first place: every field is
    either a closed set of words, an identifier matched against a fixed shape,
    or a timestamp. There is no free-text field for a credential to be pasted
    into, and `extra="forbid"` rejects a key smuggled in under a new name.

    A host, workspace URL, volume path or experiment name is deliberately absent
    for the same reason. The user is told where the work ran, not how to reach it.
    """

    model_config = ConfigDict(extra="forbid")

    location: Literal["local", "databricks"] = Field(
        description="Where the pipeline ran. 'local' is the backend process itself."
    )
    status: Literal["succeeded", "failed", "unknown"] = Field(
        default="unknown",
        description="How the run that produced this twin finished. 'unknown' when the "
        "producer cannot tell -- a served twin whose job status was never read.",
    )
    mlflow_run_id: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{32}$",
        description="MLflow run that recorded this build: 32 lowercase hex characters, "
        "MLflow's own format. None when tracking was off. The shape is enforced so "
        "that nothing else can be stored here.",
    )
    run_time: datetime | None = Field(
        default=None, description="When that run happened. None when it was not recorded."
    )


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
    one_time_obligations: list[OneTimeObligation] = Field(
        default=[],
        description="Known one-off future expenses the user declared and confirmed. "
        "Empty on a twin that predates the contract, and on any twin built purely from "
        "transactions: these can only come from the user.",
    )
    forecast: ForecastMetadata | None = Field(
        default=None,
        description="How the observed figures above were estimated. None when they were "
        "written by hand or taken as flat averages without recording the method.",
    )
    # Where the observed half came from, for the UI to label honestly: a live
    # backend with no Nessie key still serves fixture-derived data. Only
    # `twin_source` knows, so a twin assembled anywhere else leaves this None.
    # "databricks": built by the Databricks twin build job and read back from it.
    source: Literal["fixture", "nessie", "databricks"] | None = None
    # How the twin was produced, as opposed to where its data came from: the two
    # are separate facts and a twin can carry either without the other. None when
    # nothing recorded it, which the UI must show as unavailable rather than
    # guessing (frontend/SPEC.md section 3.5).
    lineage: ProcessingLineage | None = None

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


class BalanceBandPoint(BaseModel):
    """One day's spread of a balance across simulated futures."""

    date: date
    p10: float
    median: float
    p90: float


class ScenarioBands(BaseModel):
    """End-of-day balances per day, from as_of through horizon_end."""

    total: list[BalanceBandPoint] = Field(description="Checking plus savings.")
    checking: list[BalanceBandPoint]


class BalanceBands(BaseModel):
    baseline: ScenarioBands
    counterfactual: ScenarioBands


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
    balance_bands: BalanceBands | None = Field(
        default=None,
        description="Daily p10/median/p90 balances for charts. None when not computed.",
    )


# --- Optimization -------------------------------------------------------------

CandidateKind = Literal["buy_now", "delay", "reduce_spending", "from_savings"]


class OptimizationRequest(BaseModel):
    user_id: str
    events: list[SimulationEvent] = Field(min_length=1)
    horizon_end: date | None = Field(
        default=None, description="Defaults to the earliest goal deadline."
    )


class SpendingAdjustment(BaseModel):
    category: str
    multiplier: float = Field(
        ge=0, le=1, description="Scales the category's mean and spread for the whole horizon."
    )


class OptimizationCandidate(BaseModel):
    id: str
    kind: CandidateKind
    label: str
    detail: str
    events: list[SimulationEvent] = Field(description="The purchase as this action makes it.")
    spending_adjustments: list[SpendingAdjustment] = []
    metrics: ScenarioMetrics
    meets_constraints: bool
    violations: list[str] = Field(
        default=[], description="Declared hard constraints this action breaks, in words."
    )


class OptimizationResponse(BaseModel):
    optimization_id: str
    user_id: str
    request: OptimizationRequest
    horizon_end: date
    baseline: ScenarioMetrics = Field(description="The future without the purchase.")
    candidates: list[OptimizationCandidate] = Field(description="Best first.")
    recommended_id: str | None = Field(
        default=None,
        description="Best candidate that meets every hard constraint. None when none does.",
    )
    summary: str
    assumptions: list[str]
    num_simulations: int = Field(ge=1, description="Monte Carlo runs behind each candidate.")


# --- Goal compiler ------------------------------------------------------------

# "type": a goal or a standing reserve. "account": which account pays a one-time
# obligation. "intent": the text could be a goal or a declared obligation and the
# Assistant must ask rather than choose (frontend/SPEC.md 3.2).
GoalClarificationField = Literal[
    "amount", "deadline", "name", "type", "account", "intent", "mandatory"
]


class GoalCompileRequest(BaseModel):
    user_id: str
    text: str = Field(min_length=1, max_length=2000)


class GoalClarification(BaseModel):
    field: GoalClarificationField = Field(description="What is missing or ambiguous.")
    question: str
    fragment: str = Field(description="The part of the text the question is about.")


class ObligationClassificationDraft(BaseModel):
    """A category the user stated in words for an obligation TwinBank detected.

    A draft, like everything else the compiler produces. The Assistant reads it back
    and the user confirms it through POST /clarifications/respond; nothing here has
    touched `declared_category` (frontend/SPEC.md 3.2 -- the Assistant "must not
    silently turn a suggestion into a declared fact").
    """

    obligation_id: str
    obligation_name: str = Field(description="As shown to the user, so it can be read back.")
    category: ObligationCategory
    fragment: str = Field(description="The part of the text this came from.")


class GoalCompileResponse(BaseModel):
    """Drafts only: nothing is saved until the user confirms them."""

    user_id: str
    text: str
    goals: list[Goal]
    constraints: list[FinancialConstraint]
    one_time_obligations: list[OneTimeObligation] = Field(
        default=[],
        description="Drafted one-off expenses the user says they already owe, as opposed "
        "to money they are saving toward.",
    )
    classifications: list[ObligationClassificationDraft] = Field(
        default=[],
        description="Answers about already-detected recurring obligations, read back for "
        "confirmation rather than applied.",
    )
    clarifications: list[GoalClarification] = Field(
        description="Asked instead of guessing. A goal or obligation missing a detail is "
        "not drafted at all."
    )
    unparsed: list[str] = Field(description="Parts of the text that matched nothing.")
    compiler: Literal["rules", "llm"]


class DeclaredGoalsRequest(BaseModel):
    """Replaces the user's goals and emergency reserve. A minimum_checking_balance
    here sets the same value as PUT /twin/{user_id}/minimum-balance."""

    goals: list[Goal]
    constraints: list[FinancialConstraint] = []
    one_time_obligations: list[OneTimeObligation] | None = Field(
        default=None,
        description="Confirmed one-off expenses. Omitted keeps the ones already "
        "confirmed; an empty list clears them.",
    )
