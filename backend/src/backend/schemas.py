"""Shared contracts between workstreams.

This module is the source of truth for the Financial Twin and simulation
schemas. Frontend TypeScript types must mirror it. Change it only through a
small, dedicated PR (see CLAUDE.md "Shared Contracts").

Conventions: money is USD dollars, dates are ISO 8601, probabilities are 0-1.
"""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    computed_field,
    field_validator,
    model_validator,
)

# "observed" = derived from banking data; "declared" = stated by the user.
Provenance = Literal["observed", "declared"]
Probability = Field(ge=0, le=1)

# API-4 (frontend/SPEC.md section 6): money on the routes added by that spec rejects
# NaN, infinity and anything past a billion dollars. Applied to the models below
# only -- retrofitting the older contracts would change what an existing payload
# means for the other workstreams.
MAX_MONEY = 1_000_000_000
PositiveMoney = Field(gt=0, le=MAX_MONEY, allow_inf_nan=False)
NonNegativeMoney = Field(ge=0, le=MAX_MONEY, allow_inf_nan=False)
SignedMoney = Field(ge=-MAX_MONEY, le=MAX_MONEY, allow_inf_nan=False)

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
    active: bool = Field(
        default=True,
        description="False means paused: the simulator and the overview ignore it "
        "(frontend/SPEC.md 4.1, PER-6). A twin saved before this field existed loads "
        "as active.",
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


class ImpactAssessment(BaseModel):
    """How hard a purchase hits the risk metrics, scored in backend code.

    `frontend/SPEC.md` section 7.3 fixes the thresholds; the Simulator shows
    `level` as a badge and `reasons` in its tooltip, so the score is never an
    unexplained number (G-18). Deterministic code only, never a model
    (`CLAUDE.md`, LLM Responsibilities).
    """

    level: Literal["low", "moderate", "high"]
    reasons: list[str] = Field(
        default_factory=list,
        max_length=3,
        description="Plain-language deltas behind the level, most severe first.",
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
    impact: ImpactAssessment | None = Field(
        default=None,
        description="How hard this purchase hits the risk metrics. None when not scored, "
        "so older payloads still validate.",
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


# --- Overview ----------------------------------------------------------------
#
# Everything below this line is the contract for the pages described in
# frontend/SPEC.md (the minimalist layout). It is additive: nothing above was
# renamed or removed, and the routes that serve these models land in later PRs.
# Section numbers in the comments refer to that document.


def _clean_name(value: str) -> str:
    """API-5: trim the ends and collapse interior runs of whitespace.

    Runs after the length bounds, so a name of nothing but spaces is rejected here
    rather than being saved as an empty string.
    """

    cleaned = " ".join(value.split())
    if not cleaned:
        raise ValueError("name must not be blank")
    if len(cleaned) > 80:
        raise ValueError("name must be at most 80 characters")
    return cleaned


# A user-supplied name for a goal or an obligation, normalized on the way in.
EditableName = Annotated[str, Field(min_length=1, max_length=80), AfterValidator(_clean_name)]


class OverviewAccount(BaseModel):
    """An account as the Overview page lists it: no transactions, no history."""

    id: str
    name: str
    balance: float = SignedMoney


class SpendingSlice(BaseModel):
    """One wedge of the spending donut.

    `label` is a variable-spending category, "Fixed bills", or "Other". Obligations
    carry no category of spend, so TwinBank groups them rather than guessing (A13).
    """

    label: str
    monthly_amount: float = NonNegativeMoney


class UpcomingItem(BaseModel):
    name: str
    amount: float = Field(
        ge=-MAX_MONEY,
        le=MAX_MONEY,
        allow_inf_nan=False,
        description="Signed: positive is income, negative is an outflow.",
    )
    date: date
    kind: Literal["income", "recurring_bill", "one_time_bill"]


class OverviewPayload(BaseModel):
    """GET /twin/{user_id}/overview (OV-1)."""

    user_id: str
    as_of: date
    total_balance: float = SignedMoney
    monthly_net_cash_flow: float = SignedMoney
    goal_progress: float | None = Field(
        default=None, ge=0, le=1, description="None when the twin has no goals."
    )
    accounts: list[OverviewAccount]
    spending: list[SpendingSlice] = Field(
        default=[], max_length=5, description="At most four categories plus 'Other' (OV-5)."
    )
    total_monthly_spending: float = NonNegativeMoney
    upcoming: list[UpcomingItem] = Field(
        default=[], max_length=5, description="At most five, ascending by date (OV-7)."
    )

    @field_validator("upcoming")
    @classmethod
    def check_upcoming_order(cls, items: list[UpcomingItem]) -> list[UpcomingItem]:
        dates = [item.date for item in items]
        if dates != sorted(dates):
            raise ValueError("upcoming items must be ascending by date")
        return items


# --- Obligations management --------------------------------------------------


class CategoryOption(BaseModel):
    """One answer the user may pick for an unclear obligation.

    Deliberately carries no probability: the page shows plain words in likelihood
    order and never a confidence number (G-5).
    """

    category: ObligationCategory
    label: str


class RecurringObligationRow(BaseModel):
    """A recurring obligation as the Obligations page lists it (OB-1)."""

    id: str
    name: str
    amount: float = PositiveMoney
    frequency: Literal["monthly"] = Field(
        default="monthly", description="FinancialObligation is keyed on due_day only."
    )
    due_day: int = Field(ge=1, le=31)
    active: bool
    origin: Literal["detected", "declared"] = Field(
        description="detected = rebuilt from transactions, so it can be paused but not deleted."
    )
    category_label: str | None = Field(
        default=None, description="The declared category in words, None when undeclared."
    )
    needs_answer: bool = Field(
        description="Candidates exist and the user has not declared one."
    )
    options: list[CategoryOption] = Field(
        default=[], description="Most likely first, without probabilities."
    )


class OneTimeObligationRow(BaseModel):
    """A one-off expense as the Obligations page lists it (OB-1)."""

    id: str
    name: str
    amount: float = PositiveMoney
    due_date: date
    account_id: str
    account_name: str
    mandatory: bool


class ObligationsPayload(BaseModel):
    user_id: str
    as_of: date
    recurring: list[RecurringObligationRow] = []
    one_time: list[OneTimeObligationRow] = Field(
        default=[], description="Only those still ahead: due_date > as_of."
    )


class RecurringObligationCreate(BaseModel):
    """POST body. Anything the user types is declared, never detected (PER-3)."""

    name: EditableName
    amount: float = PositiveMoney
    due_day: int = Field(ge=1, le=31)
    mandatory: bool = True


class RecurringObligationChanges(BaseModel):
    """PUT body. An omitted field is unchanged; at least one must be given."""

    name: EditableName | None = None
    amount: float | None = Field(default=None, gt=0, le=MAX_MONEY, allow_inf_nan=False)
    due_day: int | None = Field(default=None, ge=1, le=31)
    active: bool | None = None

    @model_validator(mode="after")
    def check_something_changed(self) -> "RecurringObligationChanges":
        if not self.model_fields_set:
            raise ValueError("give at least one field to change")
        return self


class OneTimeObligationCreate(BaseModel):
    """POST body. The route additionally checks the date against the twin's as_of."""

    name: EditableName
    amount: float = PositiveMoney
    due_date: date
    account_id: str
    mandatory: bool = True


class OneTimeObligationChanges(BaseModel):
    """PUT body. An omitted field is unchanged; at least one must be given."""

    name: EditableName | None = None
    amount: float | None = Field(default=None, gt=0, le=MAX_MONEY, allow_inf_nan=False)
    due_date: date | None = None
    account_id: str | None = None
    mandatory: bool | None = None

    @model_validator(mode="after")
    def check_something_changed(self) -> "OneTimeObligationChanges":
        if not self.model_fields_set:
            raise ValueError("give at least one field to change")
        return self


# --- Goal and limit edits ----------------------------------------------------


class GoalChanges(BaseModel):
    """PATCH body for one goal (PL-10).

    A partial edit, so a stale client cannot overwrite the user's other goals the
    way the replace-all PUT /goals would.
    """

    name: EditableName | None = None
    target_amount: float | None = Field(default=None, gt=0, le=MAX_MONEY, allow_inf_nan=False)
    deadline: date | None = None
    current_amount: float | None = Field(default=None, ge=0, le=MAX_MONEY, allow_inf_nan=False)

    @model_validator(mode="after")
    def check_something_changed(self) -> "GoalChanges":
        if not self.model_fields_set:
            raise ValueError("give at least one field to change")
        return self


class ReserveRequest(BaseModel):
    """PUT /twin/{user_id}/reserve (PL-9). Zero removes the reserve."""

    amount: float = NonNegativeMoney


# --- Forecast view -----------------------------------------------------------


class ForecastCallout(BaseModel):
    """A high or low point worth naming on the Forecast page.

    `label` is built from a fixed template vocabulary and the twin's own content
    (FD-9). A model never writes it.
    """

    date: date
    kind: Literal["peak", "trough"]
    balance: float = SignedMoney
    label: str


class ForecastPayload(BaseModel):
    """GET /twin/{user_id}/forecast (FD-6): the baseline the simulate route cannot give."""

    user_id: str
    horizon_end: date
    bands: ScenarioBands
    callouts: list[ForecastCallout] = Field(default=[], max_length=4)
    num_simulations: int | None = Field(default=None, ge=0)
    is_mock: bool = False


# --- Committing a purchase ---------------------------------------------------


class GoalDateChange(BaseModel):
    """Moving a goal's deadline as part of committing a purchase (CM-4)."""

    goal_id: str
    from_deadline: date = Field(
        description="The deadline the client saw. A mismatch is a 409, not an overwrite."
    )
    deadline: date = Field(description="The new, later deadline.")


class CommitPurchaseRequest(BaseModel):
    """POST /twin/{user_id}/purchases/commit (CM-3). One purchase in v1."""

    events: list[SimulationEvent] = Field(min_length=1, max_length=1)
    goal_updates: list[GoalDateChange] = []


class CommitPurchaseResponse(BaseModel):
    twin: FinancialTwin
    created_ids: list[str] = Field(
        default=[], description="The one-time obligation ids now on the twin (A9)."
    )
    already_committed: bool = Field(
        default=False, description="True when this exact purchase was already there (G-15)."
    )


class EarliestDateRequest(BaseModel):
    """POST /twin/{user_id}/goals/{goal_id}/earliest-date (CM-2)."""

    events: list[SimulationEvent] = Field(min_length=1, max_length=1)


class EarliestDateResponse(BaseModel):
    goal_id: str
    original_deadline: date
    earliest_deadline: date | None = Field(
        default=None,
        description="None when no date inside the 730-day limit restores the chance.",
    )
    baseline_prob_goal_met: float | None = Field(default=None, ge=0, le=1)
    prob_goal_met_at_earliest: float | None = Field(default=None, ge=0, le=1)
    searched_until: date


# --- Assistant ---------------------------------------------------------------
#
# The Assistant only ever drafts. Nothing here changes the twin: a proposal does
# that through POST /assistant/proposals/{id}/decision with "accept" (AS-1, AS-15).
# Payloads reuse the models above so a draft validates exactly the way the twin does.

AssistantAction = Literal[
    "ADD_GOAL",
    "UPDATE_GOAL",
    "ADD_OBLIGATION",
    "UPDATE_OBLIGATION",
    "SET_CONSTRAINT",
    "CLASSIFY_OBLIGATION",
]


class ProposalBase(BaseModel):
    proposal_id: str
    status: Literal["pending", "accepted", "rejected"] = "pending"
    source_fragment: str = Field(
        min_length=1,
        description="The user's own words this came from. A quote the frontend can "
        "check against the message, where a model's 'reasoning' could not be (V1).",
    )
    requires_user_confirmation: Literal[True] = True


class AddGoalProposal(ProposalBase):
    action_type: Literal["ADD_GOAL"] = "ADD_GOAL"
    goal: Goal


class UpdateGoalProposal(ProposalBase):
    action_type: Literal["UPDATE_GOAL"] = "UPDATE_GOAL"
    goal_id: str
    goal_name: str = Field(description="As shown on the card, so the user can read it back.")
    changes: GoalChanges


class AddObligationProposal(ProposalBase):
    """One-time obligations only in v1. A recurring one is added on /obligations (Q2)."""

    action_type: Literal["ADD_OBLIGATION"] = "ADD_OBLIGATION"
    obligation: OneTimeObligation


class UpdateObligationProposal(ProposalBase):
    action_type: Literal["UPDATE_OBLIGATION"] = "UPDATE_OBLIGATION"
    obligation_id: str
    obligation_name: str
    kind: Literal["recurring", "one_time"]
    recurring_changes: RecurringObligationChanges | None = None
    one_time_changes: OneTimeObligationChanges | None = None

    @model_validator(mode="after")
    def check_changes_match_kind(self) -> "UpdateObligationProposal":
        given = self.recurring_changes if self.kind == "recurring" else self.one_time_changes
        other = self.one_time_changes if self.kind == "recurring" else self.recurring_changes
        if given is None:
            raise ValueError(f"a {self.kind} proposal needs {self.kind}_changes")
        if other is not None:
            raise ValueError(f"a {self.kind} proposal must not carry the other kind's changes")
        return self


class SetConstraintProposal(ProposalBase):
    action_type: Literal["SET_CONSTRAINT"] = "SET_CONSTRAINT"
    constraint: FinancialConstraint


class ClassifyObligationProposal(ProposalBase):
    """Answering "the $50 transfer is savings" about a detected obligation (AS-7)."""

    action_type: Literal["CLASSIFY_OBLIGATION"] = "CLASSIFY_OBLIGATION"
    classification: ObligationClassificationDraft


Proposal = Annotated[
    AddGoalProposal
    | UpdateGoalProposal
    | AddObligationProposal
    | UpdateObligationProposal
    | SetConstraintProposal
    | ClassifyObligationProposal,
    Field(discriminator="action_type"),
]


class AssistantQuestion(BaseModel):
    """Asked instead of guessing. The text comes from a template (8.3), never a model."""

    question_id: str
    text: str
    field: GoalClarificationField | Literal["which_one", "category"]
    choices: list[str] = Field(
        default=[], description="Quick replies. Empty means free text."
    )
    fragment: str


# `date` is a field name below, which shadows the type inside that class body.
IsoDate = date


class SimulatePrefill(BaseModel):
    """A what-if, handed to the Purchase Simulator filled in but not run (AS-8)."""

    description: str
    amount: float = PositiveMoney
    date: IsoDate | None = None


class AssistantMessageRequest(BaseModel):
    user_id: str
    text: str = Field(min_length=1, max_length=2000)
    conversation_id: str | None = None
    in_reply_to: str | None = Field(
        default=None,
        description="The message_id of the question being answered. Sent only when the "
        "user answers a specific question; the backend never guesses (AS-11).",
    )


class AssistantMessageResponse(BaseModel):
    conversation_id: str
    message_id: str
    reply: str = Field(description="Always from a template in 8.3, never a model's words (AS-3).")
    read_by: Literal["rules", "model"] = Field(
        description="Who read the user's words. compiler 'rules' maps to 'rules', 'llm' to 'model' (AS-4)."
    )
    proposals: list[Proposal] = Field(default=[], max_length=5)
    questions: list[AssistantQuestion] = Field(default=[], max_length=3)
    simulate_prefill: SimulatePrefill | None = None
    unparsed: list[str] = []


class AssistantOpening(BaseModel):
    """GET /assistant/opening/{user_id} (AS-9). Empty when nothing is unclassified."""

    questions: list[AssistantQuestion] = Field(default=[], max_length=2)


class ProposalDecisionRequest(BaseModel):
    decision: Literal["accept", "reject"]


class ProposalDecisionResponse(BaseModel):
    proposal_id: str
    status: Literal["accepted", "rejected"]
    twin: FinancialTwin | None = Field(
        default=None, description="The updated twin on accept, None on reject."
    )
