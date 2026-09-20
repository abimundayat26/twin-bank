"""Deterministic day-by-day cash-flow simulation over a FinancialTwin.

Pure functions only: no FastAPI, no I/O, no randomness. Every flow uses its
expected value unless a sampled Draws is passed in (see simulation/monte_carlo.py).
Variable spending runs in 14-day blocks from the day after as_of; a category with a
seasonal profile spends mean_14d times the block's factor (see forecast.block_factor).
"""

import calendar
from dataclasses import dataclass
from datetime import date, timedelta

from backend.forecast import block_factor
from backend.schemas import (
    FinancialObligation,
    FinancialTwin,
    OneTimeObligation,
    SimulationEvent,
)

# SPEC section 13: "low balance" means checking below this amount, unless the user
# declares their own minimum_checking_balance constraint. Mirrored in the frontend as
# DEFAULT_LOW_BALANCE_THRESHOLD (frontend/lib/types.ts) -- change both together.
LOW_BALANCE_THRESHOLD = 200.0
# Used when the request has no horizon_end and the twin has no goals.
DEFAULT_HORIZON_DAYS = 180
# Longest horizon a request may ask for; run time grows with every simulated day.
MAX_HORIZON_DAYS = 730
# Variable spending is modelled per block of this many days (mean_14d, std_dev_14d).
SPENDING_BLOCK_DAYS = 14


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
class SavingsSweep:
    """A mandatory bill checking could not cover alone, paid by moving savings across.

    The bill was paid: this is the warning that it took the savings account to do it,
    which is a different outcome from UncoveredObligation (not paid at all).
    """

    obligation_id: str
    name: str
    due: date
    amount: float


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
    savings_sweeps: list[SavingsSweep]
    goals: list[GoalOutcome]
    total_income: float
    # A purchase took a non-primary account (savings) below $0, which cannot really happen.
    savings_overdrawn: bool = False

    @property
    def goal_shortfall(self) -> float:
        return round(sum(g.shortfall for g in self.goals), 2)


@dataclass(frozen=True)
class Charge:
    """One withdrawal on one day: an instance of a recurring obligation, or a one-time one.

    Both kinds are settled in the same loop so that mandatory-first ordering holds
    *across* them, not merely within each. A recurring obligation is always paid from
    checking; a one-time one names its own funding account.
    """

    id: str
    name: str
    amount: float
    account_id: str
    mandatory: bool
    to_savings: bool = False


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
    if (end - twin.as_of).days > MAX_HORIZON_DAYS:
        raise SimulationError(
            f"horizon_end {end} is more than {MAX_HORIZON_DAYS} days after as_of {twin.as_of}"
        )
    return end


def reserve_amount(twin: FinancialTwin) -> float:
    return max((c.amount for c in twin.constraints if c.type == "minimum_reserve"), default=0.0)


def low_balance_threshold(twin: FinancialTwin) -> float:
    declared = [c.amount for c in twin.constraints if c.type == "minimum_checking_balance"]
    return max(declared) if declared else LOW_BALANCE_THRESHOLD


def is_mandatory(obligation: FinancialObligation) -> bool:
    """The user's declared category overrides the observed mandatory flag."""
    if obligation.declared_category in ("bill", "debt_repayment"):
        return True
    if obligation.declared_category in ("optional_spending", "savings_transfer"):
        return False
    return obligation.mandatory


def declared_commitments(twin: FinancialTwin, horizon_end: date) -> list[OneTimeObligation]:
    """One-time obligations that actually fall inside a run, in the same window as
    every other flow. One outside it never happens, so nothing may claim it was
    weighed or explained."""
    return [o for o in twin.one_time_obligations if twin.as_of < o.due_date <= horizon_end]


def savings_account_id(twin: FinancialTwin) -> str | None:
    return next((a.id for a in twin.accounts if a.type == "savings"), None)


def sweep_from_savings(balances: dict[str, float], primary: str, savings: str | None) -> float:
    """Move as much of the checking shortfall out of savings as savings can cover.

    Returns the amount moved. Total balance is unchanged; only its location moves,
    so the reserve check still sees the real shortfall.
    """
    if savings is None or savings == primary or balances[primary] >= 0:
        return 0.0
    moved = min(-balances[primary], max(0.0, balances[savings]))
    balances[primary] += moved
    balances[savings] -= moved
    return moved


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


def spending_blocks(as_of: date, horizon_end: date) -> list[list[date]]:
    """The simulated days (as_of, horizon_end] in consecutive 14-day blocks; the last may be short."""
    days = [as_of + timedelta(days=i) for i in range(1, (horizon_end - as_of).days + 1)]
    return [days[i : i + SPENDING_BLOCK_DAYS] for i in range(0, len(days), SPENDING_BLOCK_DAYS)]


def expected_daily_spending(twin: FinancialTwin, horizon_end: date) -> dict[date, float]:
    """Expected variable spending per day: each block's mean, scaled by its seasonal factor."""
    spending: dict[date, float] = {}
    for block in spending_blocks(twin.as_of, horizon_end):
        per_day = sum(
            v.mean_14d * block_factor(v.seasonal, block[0], len(block)) for v in twin.variable_spending
        ) / SPENDING_BLOCK_DAYS
        spending.update(dict.fromkeys(block, per_day))
    return spending


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
    savings = savings_account_id(twin)
    balances = {a.id: a.balance for a in twin.accounts}
    reserve = reserve_amount(twin)

    inflows: dict[date, float] = {}
    total_income = 0.0
    for stream in twin.income:
        for d in income_dates(stream.next_date, stream.interval_days, start, horizon_end):
            amount = draws.income.get((stream.id, d), stream.expected_amount) if draws else stream.expected_amount
            inflows[d] = inflows.get(d, 0.0) + amount
            total_income += amount

    charges_by_day: dict[date, list[Charge]] = {}
    for obligation in twin.obligations:
        if obligation.declared_category == "not_recurring":
            continue
        for d in monthly_due_dates(obligation.due_day, start, horizon_end):
            charges_by_day.setdefault(d, []).append(
                Charge(
                    id=obligation.id,
                    name=obligation.name,
                    amount=obligation.expected_amount,
                    account_id=primary,
                    mandatory=is_mandatory(obligation),
                    to_savings=obligation.declared_category == "savings_transfer",
                )
            )
    # A confirmed one-time obligation is a commitment already made, so it belongs to
    # the baseline as much as to any counterfactual (frontend/SPEC.md 3.2). Same
    # (start, horizon_end] window as everything else; one outside it simply never
    # happens in this run. A funding account that no longer exists falls back to
    # checking rather than silently dropping the charge.
    for one_time in twin.one_time_obligations:
        if start < one_time.due_date <= horizon_end:
            charges_by_day.setdefault(one_time.due_date, []).append(
                Charge(
                    id=one_time.id,
                    name=one_time.name,
                    amount=one_time.amount,
                    account_id=one_time.account_id if one_time.account_id in balances else primary,
                    mandatory=one_time.mandatory,
                )
            )

    events_by_day: dict[date, list[SimulationEvent]] = {}
    for event in events:
        events_by_day.setdefault(event.date, []).append(event)

    spending = draws.daily_spending if draws else {}
    if len(spending) < (horizon_end - start).days:
        spending = {**expected_daily_spending(twin, horizon_end), **spending}

    for event in events_by_day.get(start, []):
        balances[event.account_id] -= event.amount
    savings_overdrawn = any(b < 0 for acc, b in balances.items() if acc != primary)

    dates = [start]
    checking = [balances[primary]]
    total = [sum(balances.values())]
    min_total = total[0]
    min_checking, min_checking_date = checking[0], start
    uncovered: list[UncoveredObligation] = []
    sweeps: list[SavingsSweep] = []

    day = start
    while day < horizon_end:
        day += timedelta(days=1)

        for event in events_by_day.get(day, []):
            balances[event.account_id] -= event.amount
            if event.account_id != primary and balances[event.account_id] < 0:
                savings_overdrawn = True
        # Mandatory bills are paid first (stable sort keeps twin order within each group),
        # and each is settled before the next is charged, so a later optional charge can
        # never be the reason an earlier mandatory bill looks unpayable.
        for charge in sorted(charges_by_day.get(day, []), key=lambda c: not c.mandatory):
            balances[charge.account_id] -= charge.amount
            # A declared savings transfer moves money within the twin instead of spending it.
            if charge.to_savings and savings is not None:
                balances[savings] += charge.amount
            if balances[charge.account_id] < 0 and charge.account_id != primary:
                savings_overdrawn = True
            if not charge.mandatory or balances[charge.account_id] >= 0:
                continue
            if charge.account_id != primary:
                # Paid from savings and savings could not cover it. There is nowhere
                # left to sweep from, so it is simply not covered.
                uncovered.append(
                    UncoveredObligation(charge.id, charge.name, day, round(balances[charge.account_id], 2))
                )
                continue
            # Checking alone fell short. A real person moves savings across rather than
            # missing rent, so the bill is only uncovered if both accounts together fail.
            swept = sweep_from_savings(balances, primary, savings)
            if balances[primary] < 0:
                uncovered.append(
                    UncoveredObligation(charge.id, charge.name, day, round(balances[primary], 2))
                )
            elif swept > 0:
                sweeps.append(SavingsSweep(charge.id, charge.name, day, round(swept, 2)))
        balances[primary] -= spending[day]

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
        dropped_below_low=min_checking < low_balance_threshold(twin),
        reserve_violated=min_total < reserve,
        obligations_covered=not uncovered,
        uncovered_obligations=uncovered,
        savings_sweeps=sweeps,
        goals=evaluate_goals(twin, dates, total, reserve),
        total_income=round(total_income, 2),
        savings_overdrawn=savings_overdrawn,
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
