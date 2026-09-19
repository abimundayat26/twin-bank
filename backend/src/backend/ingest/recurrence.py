"""Normalized transactions -> the observed half of a Financial Twin.

The second half of Workstream 1's pipeline:

    raw bank events -> normalize -> Transaction[] -> recurrence detection -> FinancialTwin

Pure functions: no I/O, no randomness, no network. Given a year of transactions
this recovers three things, and only these three:

* income streams   - a repeating deposit, its cadence and its variability;
* obligations      - a charge that lands once a month, its day and how reliably;
* variable spending - everything else, as a per-fortnight mean and spread.

What it must never recover is *intent*. Goals and constraints are declared by
the user (SPEC section 2) and cannot be derived from a statement. Neither can
the meaning of an opaque transfer: money that left without a stated purpose
becomes an obligation carrying `category_candidates`, which is the app's cue to
ask the user rather than to decide. `declared_category` is left `None` here
always — only the user's answer fills it in.

Detection is arithmetic over dates and amounts, not inference. Every threshold
below is a stated rule with a reason attached.
"""

import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from backend.forecast import HALF_LIFE_DAYS, Fortnight, fit_category
from backend.ingest.models import Category, Transaction
from backend.schemas import (
    CategoryCandidate,
    FinancialObligation,
    ForecastMetadata,
    IncomeStream,
    ObligationCategory,
    VariableSpendingDistribution,
)

# Detection and simulation must agree on when a monthly bill falls due, so the
# calendar rule (including end-of-month clamping) is shared with the simulator
# rather than reimplemented here.
from backend.simulation.engine import monthly_due_dates

# Fewer than four events is an anecdote, not a pattern.
MIN_OCCURRENCES = 4

# Income: how far the gaps between payments may stray from the median gap,
# as a fraction of it, before the cadence is called irregular.
MAX_GAP_SPREAD = 0.2
INCOME_INTERVAL_DAYS = (5, 35)

# Obligations: a monthly charge lands on roughly the same day each month. This
# is the median distance, in days, that the charges may sit from that day.
MAX_DAY_SPREAD = 2.0
MIN_MONTHS_OBSERVED = 4

# How hard a wobbling amount pushes confidence down, per unit of coefficient of
# variation. A bill that varies by 10% loses 20% of its confidence.
AMOUNT_STABILITY_PENALTY = 2.0

# Never claim certainty about the future from past data alone.
MAX_CONFIDENCE = 0.99

# Variable spending is described per fortnight, matching the twin schema and the
# simulator's spending draws.
BLOCK_DAYS = 14

# Which observed categories are treated as mandatory. A stated rule, not a guess
# about this user: keeping the roof on and the lights on is not optional, and a
# subscription is. The user can override any of it via a declared category.
MANDATORY_CATEGORIES: frozenset[Category] = frozenset({"rent", "utilities", "phone"})

# A recurring transfer is money leaving on a schedule with no stated purpose.
# These are priors on what such a transfer usually is, not a claim about this
# user — the point of emitting them is to make the app ask. Ordered most likely
# first and summing to at most 1, as FinancialObligation requires.
TRANSFER_PRIOR: tuple[tuple[ObligationCategory, float], ...] = (
    ("savings_transfer", 0.55),
    ("debt_repayment", 0.30),
    ("optional_spending", 0.15),
)


@dataclass(frozen=True)
class Cadence:
    """A repeating gap between events."""

    interval_days: int
    regularity: float  # 0-1; 1 means every gap equals the median gap.
    occurrences: int
    last_date: date


@dataclass(frozen=True)
class Monthly:
    """A charge that lands once a month, near the same day."""

    due_day: int
    day_spread: float  # median distance from due_day, in days.
    months_observed: int
    months_eligible: int


@dataclass(frozen=True)
class DetectedStructure:
    """The observed half of a twin. The declared half is not in here by design."""

    income: list[IncomeStream]
    obligations: list[FinancialObligation]
    variable_spending: list[VariableSpendingDistribution]
    # How variable_spending was estimated. None only when there was no history.
    forecast: ForecastMetadata | None = None


# --- Grouping -----------------------------------------------------------------

# Tokens that carry a store or account number vary per visit ("KROGER #418",
# "FOOD LION 2231", "ONLINE TRANSFER TO ***4471"), so they are not part of the
# merchant's identity. Anything with a digit in it goes.
_NUMBERED_TOKEN = re.compile(r"\S*\d\S*")


def merchant_key(description: str) -> str:
    """A stable identity for a merchant, ignoring per-visit numbering.

    Falls back to the whole description when stripping numbers leaves nothing,
    so a purely numeric payee still groups with itself instead of with every
    other numeric payee.
    """
    stripped = _NUMBERED_TOKEN.sub(" ", description.upper())
    return " ".join(stripped.split()) or " ".join(description.upper().split())


def slug(text: str) -> str:
    """An id-safe form of a merchant key."""
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", text.lower())).strip("_")


def group_by_merchant(transactions: list[Transaction]) -> dict[str, list[Transaction]]:
    groups: dict[str, list[Transaction]] = defaultdict(list)
    for transaction in transactions:
        groups[merchant_key(transaction.description)].append(transaction)
    return {key: sorted(group, key=lambda t: (t.date, t.id)) for key, group in groups.items()}


def dominant_category(group: list[Transaction]) -> Category:
    return Counter(t.category for t in group).most_common(1)[0][0]


# --- Statistics ---------------------------------------------------------------


def median_deviation(values: list[float], centre: float) -> float:
    """Typical distance from `centre`, ignoring a lone outlier.

    Used for the day a bill lands: one charge pushed off its usual day says
    little about the others.
    """
    return statistics.median([abs(v - centre) for v in values]) if values else 0.0


def mean_deviation(values: list[float], centre: float) -> float:
    """Average distance from `centre`, where every departure counts.

    Used for the gaps between payments: a stream that skipped once really is
    less regular than one that never did, and `regularity` should say so.
    """
    return statistics.fmean([abs(v - centre) for v in values]) if values else 0.0


def coefficient_of_variation(values: list[float]) -> float:
    """Relative spread of amounts. 0 for a flat bill, larger as it wobbles."""
    if len(values) < 2:
        return 0.0
    mean = statistics.fmean(values)
    return statistics.stdev(values) / mean if mean else 0.0


def amount_stability(values: list[float]) -> float:
    """1 for an amount that never moves, falling towards 0 as it varies."""
    return max(0.0, 1.0 - AMOUNT_STABILITY_PENALTY * coefficient_of_variation(values))


# --- Cadence (income) ---------------------------------------------------------


def detect_cadence(dates: list[date]) -> Cadence | None:
    """The repeating gap in a series of dates, or None if there isn't one.

    The interval is the *median* gap, not the mean: a single missed payment
    should widen the spread and cost regularity, not double the inferred
    interval.
    """
    ordered = sorted(dates)
    if len(ordered) < MIN_OCCURRENCES:
        return None
    gaps = [float((b - a).days) for a, b in zip(ordered, ordered[1:])]
    interval = round(statistics.median(gaps))
    if interval <= 0:
        return None
    regularity = max(0.0, 1.0 - mean_deviation(gaps, interval) / interval)
    return Cadence(
        interval_days=interval,
        regularity=regularity,
        occurrences=len(ordered),
        last_date=ordered[-1],
    )


def is_regular_income(cadence: Cadence) -> bool:
    low, high = INCOME_INTERVAL_DAYS
    return cadence.regularity >= 1.0 - MAX_GAP_SPREAD and low <= cadence.interval_days <= high


def next_occurrence(last: date, interval_days: int, as_of: date) -> date:
    """The first occurrence strictly after `as_of`."""
    upcoming = last + timedelta(days=interval_days)
    while upcoming <= as_of:
        upcoming += timedelta(days=interval_days)
    return upcoming


def detect_income(transactions: list[Transaction], as_of: date) -> list[IncomeStream]:
    """Repeating deposits, as income streams.

    Only `income` transactions qualify. An inbound transfer is money arriving
    without a stated source, and calling it income would be a guess.
    """
    deposits = [t for t in transactions if t.amount > 0 and t.category == "income"]
    streams = []
    for key, group in group_by_merchant(deposits).items():
        cadence = detect_cadence([t.date for t in group])
        if cadence is None or not is_regular_income(cadence):
            continue
        amounts = [t.amount for t in group]
        expected = round(statistics.fmean(amounts), 2)
        if expected <= 0:
            continue
        streams.append(
            IncomeStream(
                id=f"inc_{slug(key)}",
                source=key.title(),
                expected_amount=expected,
                interval_days=cadence.interval_days,
                next_date=next_occurrence(cadence.last_date, cadence.interval_days, as_of),
                uncertainty=round(statistics.stdev(amounts), 2) if len(amounts) > 1 else 0.0,
            )
        )
    return sorted(streams, key=lambda s: -s.expected_amount)


# --- Monthly charges (obligations) --------------------------------------------


def detect_monthly(dates: list[date], window_start: date, as_of: date) -> Monthly | None:
    """A once-a-month charge, or None.

    Months are counted by their *due date*, not by the calendar: the number of
    chances the charge had to happen inside the observed window is the honest
    denominator for how reliable it is. A charge that lands several times a
    month (a grocery run) is rejected here and handled as variable spending.
    """
    ordered = sorted(dates)
    if len(ordered) < MIN_OCCURRENCES:
        return None

    days = [float(d.day) for d in ordered]
    due_day = int(statistics.median_low(days))
    day_spread = median_deviation(days, due_day)
    if day_spread > MAX_DAY_SPREAD:
        return None

    months_observed = len({(d.year, d.month) for d in ordered})
    if months_observed < MIN_MONTHS_OBSERVED:
        return None
    # Allow one doubled-up month (a bill paid twice) but no more, or this is not
    # a monthly charge at all.
    if len(ordered) > months_observed + 1:
        return None

    # `monthly_due_dates` excludes its start bound; step back a day so a charge
    # landing on the window's first day still counts as a chance it had.
    eligible = monthly_due_dates(due_day, window_start - timedelta(days=1), as_of)
    if not eligible:
        return None
    return Monthly(
        due_day=due_day,
        day_spread=day_spread,
        months_observed=months_observed,
        months_eligible=len(eligible),
    )


def confidence_for(monthly: Monthly, amounts: list[float]) -> float:
    """How reliably this charge recurs: how often it happened, damped by how much it moves.

    Capped below 1: a year of perfect rent payments is strong evidence, but it
    is not a guarantee about next month, and the twin should not say it is.
    """
    frequency = min(1.0, monthly.months_observed / monthly.months_eligible)
    return round(min(MAX_CONFIDENCE, frequency * amount_stability(amounts)), 2)


def candidates_for(category: Category) -> list[CategoryCandidate]:
    """Category candidates for a charge whose purpose the data does not state.

    Only opaque transfers get them. Everything else has a purpose written on the
    statement, and a non-empty list here is what makes the app ask the user.
    """
    if category != "transfer":
        return []
    return [CategoryCandidate(category=name, probability=p) for name, p in TRANSFER_PRIOR]


def detect_obligations(
    transactions: list[Transaction], window_start: date, as_of: date
) -> tuple[list[FinancialObligation], set[str]]:
    """Monthly charges, plus the merchant keys they consumed.

    The keys come back so the caller can hand everything else to variable
    spending without detecting recurrence twice.
    """
    outflows = [t for t in transactions if t.amount < 0]
    obligations, recurring_keys = [], set()
    for key, group in group_by_merchant(outflows).items():
        monthly = detect_monthly([t.date for t in group], window_start, as_of)
        if monthly is None:
            continue
        amounts = [abs(t.amount) for t in group]
        expected = round(statistics.median(amounts), 2)
        if expected <= 0:
            continue
        category = dominant_category(group)
        recurring_keys.add(key)
        obligations.append(
            FinancialObligation(
                id=f"obl_{slug(key)}",
                name=key.title(),
                expected_amount=expected,
                due_day=monthly.due_day,
                mandatory=category in MANDATORY_CATEGORIES,
                confidence=confidence_for(monthly, amounts),
                category_candidates=candidates_for(category),
            )
        )
    return sorted(obligations, key=lambda o: o.due_day), recurring_keys


# --- Variable spending --------------------------------------------------------


def fortnight_blocks(window_start: date, as_of: date) -> list[tuple[date, date]]:
    """Whole 14-day blocks, counted back from `as_of`, oldest first.

    Counted back from today, not forward from the oldest record, so the recent
    fortnights — the ones that describe how this user spends now — are always
    whole. The leftover days at the start of the window are dropped: a partial
    block holds less than a fortnight of spending and averaging it in as though
    it were full would understate the mean.
    """
    count = (as_of - window_start).days // BLOCK_DAYS
    blocks = []
    for index in range(count, 0, -1):
        end = as_of - timedelta(days=BLOCK_DAYS * (index - 1))
        blocks.append((end - timedelta(days=BLOCK_DAYS - 1), end))
    return blocks


def detect_variable_spending(
    transactions: list[Transaction],
    recurring_keys: set[str],
    window_start: date,
    as_of: date,
) -> list[VariableSpendingDistribution]:
    """Everything that leaves that is not a monthly obligation, per fortnight.

    Non-recurring transfers are included, under the category "transfer". That
    records the observed fact that the money left without claiming to know what
    it was for; the simulator needs the outflow either way.

    The mean and spread come from `backend.forecast`: recency-weighted, and
    deseasonalized when the category has a clear seasonal shape, which then
    comes back as `seasonal`. A short history gets no shape and the plain
    recency-weighted mean.
    """
    blocks = fortnight_blocks(window_start, as_of)
    if not blocks:
        return []

    leftovers = [
        t
        for t in transactions
        if t.amount < 0 and merchant_key(t.description) not in recurring_keys
    ]
    by_category: dict[Category, list[Transaction]] = defaultdict(list)
    for transaction in leftovers:
        by_category[transaction.category].append(transaction)

    distributions = []
    for category, group in by_category.items():
        fortnights = [
            Fortnight(start, end, sum(abs(t.amount) for t in group if start <= t.date <= end))
            for start, end in blocks
        ]
        mean, spread, seasonal = fit_category(fortnights, as_of)
        if mean <= 0:
            continue
        distributions.append(
            VariableSpendingDistribution(
                category=category,
                mean_14d=round(mean, 2),
                std_dev_14d=round(spread, 2),
                seasonal=seasonal,
            )
        )
    return sorted(distributions, key=lambda d: -d.mean_14d)


# --- The whole observed half --------------------------------------------------


def detect_structure(transactions: list[Transaction], as_of: date) -> DetectedStructure:
    """Recover income, obligations and variable spending from a transaction history.

    `as_of` is the day the twin describes; the observation window runs from the
    earliest transaction up to it.
    """
    if not transactions:
        return DetectedStructure(income=[], obligations=[], variable_spending=[])

    window_start = min(t.date for t in transactions)
    obligations, recurring_keys = detect_obligations(transactions, window_start, as_of)
    variable_spending = detect_variable_spending(transactions, recurring_keys, window_start, as_of)
    seasonal = any(v.seasonal is not None for v in variable_spending)
    return DetectedStructure(
        income=detect_income(transactions, as_of),
        obligations=obligations,
        variable_spending=variable_spending,
        forecast=ForecastMetadata(
            method="seasonal_ewma" if seasonal else "flat_mean",
            as_of=as_of,
            window_start=window_start,
            observed_fortnights=len(fortnight_blocks(window_start, as_of)),
            # fit_category recency-weights every category, with or without a
            # seasonal profile, so the half-life always applies.
            half_life_days=HALF_LIFE_DAYS,
        ),
    )
