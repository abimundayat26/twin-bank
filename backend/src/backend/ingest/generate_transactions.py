"""Generate the mock raw transaction feed for Alex.

Phase 3 will pull these records from Nessie. Until then we need a year of
plausible raw events to develop normalization and recurrence detection against,
and hand-writing ~400 transactions is not practical.

The feed is generated *from* `twin_seed.json`, so the structure the detector is
supposed to rediscover — a $720 paycheck every 14 days, rent on the 1st, ~$150
of groceries per fortnight — is really present in the data rather than asserted
alongside it. The seed is the hand-written input and nothing else reads it;
`twin.json` is what the detector produces from this feed and what the app
serves. Keeping them as two files keeps that a real round trip: a generator fed
from its own output would prove nothing. The generator is seeded, so the
committed fixture is reproducible:

    cd backend && uv run python -m backend.ingest.generate_transactions

Randomness lives here, in fixture generation, never in the simulation path.

Spending also has a *shape*: Alex spends like a student, not like a metronome.
September is move-in and textbooks, December is travel and presents, summer is
quiet. `SEASONAL_WEIGHTS` below is that shape, and it exists so a forecast has
something real to recover — the same reason the feed is generated from the twin
rather than hand-written. Anything fitted to a feed with no shape in it is
fitting noise, and a test asserting it found a trend would only be asserting an
artifact of the seed.

There is deliberately no long-run drift. The window is 364 days, so an annual
cycle and a linear trend are not separately identifiable from one pass of the
data: a trend fitted to twelve months of a student's life is confounded with the
academic year itself. One signal that can be cleanly recovered is worth more
than two that alias each other.
"""

import json
import random
from datetime import date, timedelta
from pathlib import Path

from backend.fixtures import FIXTURES_DIR, load_seed_twin
from backend.schemas import FinancialTwin

SEED = 20260919
HISTORY_DAYS = 364  # 26 whole fortnights, so the 14-day blocks divide evenly.
OUTPUT_PATH = FIXTURES_DIR / "transactions.json"

# How each recurring flow shows up on a statement. Keyed by the id in
# twin_seed.json; anything missing falls back to the obligation's own name.
DESCRIPTIONS = {
    "inc_paycheck": "CAMPUS BOOKSTORE PAYROLL",
    "obl_rent": "HOKIE PROPERTY MGMT RENT",
    "obl_utilities": "TOWN ELECTRIC UTILITY",
    "obl_phone": "VERIZON WIRELESS",
    "obl_subscriptions": "SPOTIFY PREMIUM",
    # Deliberately opaque: the statement says money left, not what it was for.
    "obl_mystery_transfer": "ONLINE TRANSFER TO ***4471",
}

MERCHANTS = {
    "groceries": ("KROGER #418", "FOOD LION 2231", "ALDI MARKET", "TRADER JOES 552"),
    "discretionary": (
        "CAMPUS COFFEE CO",
        "DOORDASH*ORDER",
        "UBER TRIP",
        "STEAM GAMES",
        "CINEMA 12",
        "PHO 79 RESTAURANT",
    ),
}

# Transfers are recorded as transfers; everything else Alex pays is a purchase.
RAW_TYPES = {"obl_mystery_transfer": "transfer"}

# How much of a normal month Alex spends, per calendar month, per category.
# These are raw weights: `seasonal_factor` normalizes them so they average 1.0,
# which keeps the year's total spending at what twin.json says and moves only
# its shape. A category with no entry here is flat.
#
# The story they tell: Alex is on campus during term and cooks for himself;
# over the summer and at Christmas he is at his parents', so the groceries stop.
# September is move-in and textbooks and meeting people, December is travel and
# presents, and neither is subtle.
#
# Each category takes only a handful of distinct levels, and that is the
# important property, not the particular numbers. Twelve free monthly factors
# cannot be estimated from twelve monthly observations: the relative error on
# each one is the category's coefficient of variation over the root of its
# observation count, so with one observation per month it stays around 40% no
# matter how large the effect is. A few levels with many fortnights each is a
# model a forecast can actually fit -- see tests/test_seasonality.py, which
# fails if the levels stop being recoverable.
GROCERIES_ON_CAMPUS, GROCERIES_LEAVING, GROCERIES_AWAY = 1.25, 0.90, 0.45
DISCRETIONARY_SPIKE, DISCRETIONARY_TERM, DISCRETIONARY_QUIET = 2.00, 1.00, 0.50

SEASONAL_WEIGHTS: dict[str, dict[int, float]] = {
    "groceries": {
        1: GROCERIES_ON_CAMPUS, 2: GROCERIES_ON_CAMPUS, 3: GROCERIES_ON_CAMPUS,
        4: GROCERIES_ON_CAMPUS, 5: GROCERIES_LEAVING, 6: GROCERIES_AWAY,
        7: GROCERIES_AWAY, 8: GROCERIES_AWAY, 9: GROCERIES_ON_CAMPUS,
        10: GROCERIES_ON_CAMPUS, 11: GROCERIES_ON_CAMPUS, 12: GROCERIES_AWAY,
    },
    "discretionary": {
        1: DISCRETIONARY_TERM, 2: DISCRETIONARY_TERM, 3: DISCRETIONARY_TERM,
        4: DISCRETIONARY_TERM, 5: DISCRETIONARY_QUIET, 6: DISCRETIONARY_QUIET,
        7: DISCRETIONARY_QUIET, 8: DISCRETIONARY_QUIET, 9: DISCRETIONARY_SPIKE,
        10: DISCRETIONARY_TERM, 11: DISCRETIONARY_TERM, 12: DISCRETIONARY_SPIKE,
    },
}


def month_starts(start: date, end: date) -> list[date]:
    """First of each month touching the window."""
    out, year, month = [], start.year, start.month
    while (year, month) <= (end.year, end.month):
        out.append(date(year, month, 1))
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return out


def clamped_day(first_of_month: date, day: int) -> date:
    """`day` in that month, clamped to the last day for short months."""
    next_month = (
        date(first_of_month.year + 1, 1, 1)
        if first_of_month.month == 12
        else date(first_of_month.year, first_of_month.month + 1, 1)
    )
    last_day = (next_month - timedelta(days=1)).day
    return first_of_month.replace(day=min(day, last_day))


def seasonal_factor(category: str, start: date, end: date) -> float:
    """How much of a normal fortnight this block is worth, for this category.

    Normalized so a category's twelve monthly weights average 1.0: the shape of
    the year moves, the size of it does not, and `twin.json` stays the true
    annual average that the feed varies around.

    Averaged over the block's days rather than taken from one of them, because a
    14-day block usually straddles two months and a cliff at the boundary would
    be an artifact of where the blocks happen to start. Consumes no randomness,
    so adding it does not reshuffle any other draw.
    """
    weights = SEASONAL_WEIGHTS.get(category)
    if not weights:
        return 1.0
    mean_weight = sum(weights.values()) / len(weights)
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    return sum(weights[d.month] for d in days) / len(days) / mean_weight


def paycheck_events(twin: FinancialTwin, rng: random.Random, start: date, end: date) -> list[dict]:
    """Paychecks stepped backwards from the twin's next_date, so the cadence lines up."""
    events, account = [], checking_id(twin)
    for stream in twin.income:
        day = stream.next_date - timedelta(days=stream.interval_days)
        while day >= start:
            if day <= end:
                amount = round(max(0.0, rng.gauss(stream.expected_amount, stream.uncertainty)), 2)
                events.append(
                    raw(account, "deposit", day, amount, DESCRIPTIONS.get(stream.id, stream.source))
                )
            day -= timedelta(days=stream.interval_days)
    return events


def obligation_events(
    twin: FinancialTwin, rng: random.Random, start: date, end: date
) -> list[dict]:
    """One event per obligation per month.

    Low-confidence obligations wobble in amount and occasionally skip a month —
    that irregularity is exactly what makes them low-confidence, and the
    detector has to earn the confidence score back from it.
    """
    events, account = [], checking_id(twin)
    for obligation in twin.obligations:
        for first in month_starts(start, end):
            day = clamped_day(first, obligation.due_day)
            if not start <= day <= end:
                continue
            if rng.random() > obligation.confidence:
                continue  # A month where it did not happen.
            jitter = 0.0 if obligation.confidence >= 0.95 else 0.08
            amount = round(obligation.expected_amount * (1 + rng.uniform(-jitter, jitter)), 2)
            events.append(
                raw(
                    account,
                    RAW_TYPES.get(obligation.id, "purchase"),
                    day,
                    amount,
                    DESCRIPTIONS.get(obligation.id, obligation.name.upper()),
                )
            )
    return events


def spending_events(twin: FinancialTwin, rng: random.Random, start: date, end: date) -> list[dict]:
    """Variable spending, drawn per 14-day block and split into individual trips.

    The block total is what the twin describes (`mean_14d`, `std_dev_14d`) times
    that block's seasonal factor; how it splits into three to six purchases is
    noise, which is the point — the detector should recover the fortnightly
    distribution, not the trips.

    The standard deviation is scaled alongside the mean, not held fixed, so a
    busy month is proportionally more variable rather than implausibly steady.
    It also keeps the coefficient of variation constant, which means a quiet
    month is no likelier than before to draw its way down to nothing.
    """
    events, account = [], checking_id(twin)
    for category in twin.variable_spending:
        merchants = MERCHANTS.get(category.category, (category.category.upper(),))
        block_start = start
        # Whole blocks only: a partial block would still draw a full fortnight's
        # spending and pile it onto the last day or two.
        while block_start + timedelta(days=13) <= end:
            block_end = block_start + timedelta(days=13)
            factor = seasonal_factor(category.category, block_start, block_end)
            total = max(
                0.0, rng.gauss(category.mean_14d * factor, category.std_dev_14d * factor)
            )
            trips = rng.randint(3, 6)
            weights = [rng.uniform(0.5, 1.5) for _ in range(trips)]
            span = (block_end - block_start).days
            for weight in weights:
                amount = round(total * weight / sum(weights), 2)
                if amount <= 0:
                    continue
                day = block_start + timedelta(days=rng.randint(0, span))
                events.append(
                    raw(account, "purchase", day, amount, rng.choice(merchants))
                )
            block_start += timedelta(days=14)
    return events


def checking_id(twin: FinancialTwin) -> str:
    return next(a.id for a in twin.accounts if a.type == "checking")


def raw(account_id: str, raw_type: str, day: date, amount: float, description: str) -> dict:
    return {
        "account_id": account_id,
        "type": raw_type,
        "transaction_date": day.isoformat(),
        "amount": amount,
        "description": description,
        "status": "completed",
    }


def build_feed(twin: FinancialTwin, seed: int = SEED) -> list[dict]:
    """The full raw feed, oldest first, with stable ids."""
    rng = random.Random(seed)
    end = twin.as_of
    start = end - timedelta(days=HISTORY_DAYS)

    events = (
        paycheck_events(twin, rng, start, end)
        + obligation_events(twin, rng, start, end)
        + spending_events(twin, rng, start, end)
    )
    events.sort(key=lambda e: (e["transaction_date"], e["description"], e["amount"]))

    # A couple of still-pending purchases at the very end, so downstream code is
    # exercised against a feed that is not entirely settled.
    for event in events[-2:]:
        event["status"] = "pending"

    for index, event in enumerate(events, start=1):
        event["_id"] = f"txn_{index:04d}"
    return [reorder(event) for event in events]


def reorder(event: dict) -> dict:
    """Put `_id` first so the fixture reads like a bank statement."""
    keys = ("_id", "account_id", "type", "transaction_date", "amount", "description", "status")
    return {key: event[key] for key in keys}


def write_feed(path: Path = OUTPUT_PATH) -> int:
    feed = build_feed(load_seed_twin())
    path.write_text(json.dumps(feed, indent=2) + "\n")
    return len(feed)


if __name__ == "__main__":
    count = write_feed()
    print(f"wrote {count} raw transactions to {OUTPUT_PATH}")
