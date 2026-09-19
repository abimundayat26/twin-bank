"""Deterministic day-by-day cash-flow simulation over a FinancialTwin.

Pure functions only: no FastAPI, no I/O, no randomness. Every flow uses its
expected value unless a sampled Draws is passed in (see simulation/monte_carlo.py).
"""

import calendar
from dataclasses import dataclass
from datetime import date, timedelta

from backend.schemas import FinancialTwin, SimulationEvent

# Assumption (SPEC open question): "low balance" means checking below this amount.
LOW_BALANCE_THRESHOLD = 500.0
# Used when the request has no horizon_end and the twin has no goals.
DEFAULT_HORIZON_DAYS = 180


class SimulationError(ValueError):
    """The request cannot be simulated against this twin."""


@dataclass(frozen=True)
class GoalOutcome:
    goal_id: str
    name: str
    target_amount: float
    deadline: date
    available: float  # total balance at deadline, minus reserve and earlier goals
    shortfall: float
    surplus: float


@dataclass(frozen=True)
class UncoveredObligation:
    obligation_id: str
    name: str
    due: date
    checking_after: float


@dataclass(frozen=True)
class ScenarioResult:
    dates: list[date]  # as_of, then each simulated day
    checking: list[float]  # end-of-day checking balance
    total: list[float]  # end-of-day total balance
    ending_balance: float
    min_balance: float  # lowest total, measured after each day's outflows
    min_checking: float
    min_checking_date: date
    dropped_below_low: bool
    reserve_violated: bool
    obligations_covered: bool
    uncovered_obligations: list[UncoveredObligation]
    goals: list[GoalOutcome]
    total_income: float

    @property
    def goal_shortfall(self) -> float:
        return round(sum(g.shortfall for g in self.goals), 2)


@dataclass(frozen=True)
class Draws:
    """Sampled amounts for one simulated future. Missing keys use expected values."""

    income: dict[tuple[str, date], float]  # (income stream id, pay date) -> amount
    daily_spending: dict[date, float]  # day -> total variable spending that day


@dataclass(frozen=True)
class Comparison:
    horizon_end: date
    reserve: float
    baseline: ScenarioResult
    counterfactual: ScenarioResult


def resolve_horizon_end(twin: FinancialTwin, horizon_end: date | None) -> date:
    if horizon_end is not None:
        end = horizon_end
    elif twin.goals:
        end = min(g.deadline for g in twin.goals)
    else:
        end = twin.as_of + timedelta(days=DEFAULT_HORIZON_DAYS)
    if end <= twin.as_of:
        raise SimulationError(f"horizon_end {end} must be after as_of {twin.as_of}")
    return end


def reserve_amount(twin: FinancialTwin) -> float:
    return max((c.amount for c in twin.constraints if c.type == "minimum_reserve"), default=0.0)


def primary_account_id(twin: FinancialTwin) -> str:
    """Income, bills and spending flow through the first checking account."""
    if not twin.accounts:
        raise SimulationError("Twin has no accounts")
    for account in twin.accounts:
        if account.type == "checking":
            return account.id
    return twin.accounts[0].id


def income_dates(next_date: date, interval_days: int, start: date, end: date) -> list[date]:
    """Payment dates in (start, end]."""
    dates = []
    d = next_date
    while d <= end:
        if d > start:
            dates.append(d)
        d += timedelta(days=interval_days)
    return dates


def monthly_due_dates(due_day: int, start: date, end: date) -> list[date]:
    """Due dates in (start, end]; due_day is clamped to the month's last day."""
    dates = []
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        last_day = calendar.monthrange(year, month)[1]
        d = date(year, month, min(due_day, last_day))
        if start < d <= end:
            dates.append(d)
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return dates


def validate_events(twin: FinancialTwin, events: list[SimulationEvent], horizon_end: date) -> None:
    account_ids = {a.id for a in twin.accounts}
    for event in events:
        if event.account_id not in account_ids:
            raise SimulationError(f"Unknown account_id '{event.account_id}'")
        if not twin.as_of <= event.date <= horizon_end:
            raise SimulationError(
                f"Event date {event.date} is outside {twin.as_of} to {horizon_end}"
            )


def simulate_scenario(
    twin: FinancialTwin,
    events: list[SimulationEvent],
    horizon_end: date,
    draws: Draws | None = None,
) -> ScenarioResult:
    """Project balances from twin.as_of through horizon_end (inclusive).

    Starting balances are end-of-day as_of; events dated as_of apply before day 1.
    Within each day, outflows are applied before inflows (conservative), and the
    minimum balances are measured after outflows. Without draws, every flow uses
    its expected value.
    """
    validate_events(twin, events, horizon_end)
    start = twin.as_of
    primary = primary_account_id(twin)
    balances = {a.id: a.balance for a in twin.accounts}
    reserve = reserve_amount(twin)

    inflows: dict[date, float] = {}
    total_income = 0.0
    for stream in twin.income:
        for d in income_dates(stream.next_date, stream.interval_days, start, horizon_end):
            amount = draws.income.get((stream.id, d), stream.expected_amount) if draws else stream.expected_amount
            inflows[d] = inflows.get(d, 0.0) + amount
            total_income += amount

    obligations_by_day: dict[date, list] = {}
    for obligation in twin.obligations:
        for d in monthly_due_dates(obligation.due_day, start, horizon_end):
            obligations_by_day.setdefault(d, []).append(obligation)

    events_by_day: dict[date, list[SimulationEvent]] = {}
    for event in events:
        events_by_day.setdefault(event.date, []).append(event)

    expected_daily_spending = sum(v.mean_14d for v in twin.variable_spending) / 14

    for event in events_by_day.get(start, []):
        balances[event.account_id] -= event.amount

    dates = [start]
    checking = [balances[primary]]
    total = [sum(balances.values())]
    min_total = total[0]
    min_checking, min_checking_date = checking[0], start
    uncovered: list[UncoveredObligation] = []

    day = start
    while day < horizon_end:
        day += timedelta(days=1)

        for event in events_by_day.get(day, []):
            balances[event.account_id] -= event.amount
        due_today = obligations_by_day.get(day, [])
        for obligation in due_today:
            balances[primary] -= obligation.expected_amount
        for obligation in due_today:
            if obligation.mandatory and balances[primary] < 0:
                uncovered.append(
                    UncoveredObligation(obligation.id, obligation.name, day, round(balances[primary], 2))
                )
        balances[primary] -= (
            draws.daily_spending.get(day, expected_daily_spending) if draws else expected_daily_spending
        )

        low_total = sum(balances.values())
        min_total = min(min_total, low_total)
        if balances[primary] < min_checking:
            min_checking, min_checking_date = balances[primary], day

        balances[primary] += inflows.get(day, 0.0)

        dates.append(day)
        checking.append(balances[primary])
        total.append(sum(balances.values()))

    return ScenarioResult(
        dates=dates,
        checking=[round(x, 2) for x in checking],
        total=[round(x, 2) for x in total],
        ending_balance=round(total[-1], 2),
        min_balance=round(min_total, 2),
        min_checking=round(min_checking, 2),
        min_checking_date=min_checking_date,
        dropped_below_low=min_checking < LOW_BALANCE_THRESHOLD,
        reserve_violated=min_total < reserve,
        obligations_covered=not uncovered,
        uncovered_obligations=uncovered,
        goals=evaluate_goals(twin, dates, total, reserve),
        total_income=round(total_income, 2),
    )


def evaluate_goals(
    twin: FinancialTwin, dates: list[date], total: list[float], reserve: float
) -> list[GoalOutcome]:
    """Goals are funded on top of the reserve, earliest deadline first.

    Only goals whose deadline falls inside the simulated horizon are evaluated.
    A goal's current_amount is assumed to already be inside the account balances.
    """
    total_on = dict(zip(dates, total))
    outcomes = []
    earmarked = 0.0
    for goal in sorted(twin.goals, key=lambda g: g.deadline):
        if goal.deadline not in total_on or goal.deadline == twin.as_of:
            continue
        available = total_on[goal.deadline] - reserve - earmarked
        outcomes.append(
            GoalOutcome(
                goal_id=goal.id,
                name=goal.name,
                target_amount=goal.target_amount,
                deadline=goal.deadline,
                available=round(available, 2),
                shortfall=round(max(0.0, goal.target_amount - available), 2),
                surplus=round(max(0.0, available - goal.target_amount), 2),
            )
        )
        earmarked += goal.target_amount
    return outcomes


def compare(
    twin: FinancialTwin, events: list[SimulationEvent], horizon_end: date | None = None
) -> Comparison:
    """Baseline (no hypothetical events) vs counterfactual (with them)."""
    end = resolve_horizon_end(twin, horizon_end)
    return Comparison(
        horizon_end=end,
        reserve=reserve_amount(twin),
        baseline=simulate_scenario(twin, [], end),
        counterfactual=simulate_scenario(twin, events, end),
    )
