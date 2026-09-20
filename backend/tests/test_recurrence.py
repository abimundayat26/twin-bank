"""Recurrence detection: unit behaviour, then recovery of Alex's twin.

The recovery tests matter most. `fixtures/transactions.json` was generated *from*
`fixtures/twin_seed.json`, so running the detector over that feed and comparing
the result to the seed asks the real question: can the structure be found again
in the data? Tolerances are wide on purpose — the generator adds noise, and they
track its SEED. If anyone regenerates the feed, expect to widen them.

They compare against the seed, never `twin.json`. `twin.json` is the detector's
own output, so comparing it to a detector run would prove only that the same
code ran twice. The seed is the hand-written structure that went into the feed,
which is the thing worth recovering.
"""

from datetime import date, timedelta

import pytest

from backend.fixtures import load_raw_transactions, load_seed_twin
from backend.forecast import HALF_LIFE_DAYS, MIN_FORTNIGHTS_FOR_SEASONALITY
from backend.ingest.build import build_twin
from backend.ingest.models import Category, Transaction
from backend.ingest.normalize import normalize_all
from backend.ingest.recurrence import (
    detect_cadence,
    detect_income,
    detect_monthly,
    detect_obligations,
    detect_structure,
    detect_variable_spending,
    fortnight_blocks,
    merchant_key,
    slug,
)

AS_OF = date(2026, 9, 19)
WINDOW_START = AS_OF - timedelta(days=364)


def txn(
    day: date,
    amount: float,
    description: str,
    category: Category = "other",
    index: int = 0,
) -> Transaction:
    return Transaction(
        id=f"t_{day.isoformat()}_{index}",
        account_id="acc_checking",
        date=day,
        amount=amount,
        description=description,
        category=category,
    )


def monthly_series(
    due_day: int, amount: float, description: str, category: Category, months: list[int]
) -> list[Transaction]:
    """One charge per listed month, counting back from September 2026."""
    return [
        txn(date(2026, month, due_day), -amount, description, category, index=month)
        for month in months
    ]


# --- Grouping -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("description", "expected"),
    [
        ("KROGER #418", "KROGER"),
        ("FOOD LION 2231", "FOOD LION"),
        ("ONLINE TRANSFER TO ***4471", "ONLINE TRANSFER TO"),
        ("HOKIE PROPERTY MGMT RENT", "HOKIE PROPERTY MGMT RENT"),
        ("  spotify   premium ", "SPOTIFY PREMIUM"),
    ],
)
def test_merchant_key_ignores_per_visit_numbering(description: str, expected: str) -> None:
    assert merchant_key(description) == expected


def test_merchant_key_keeps_an_all_numeric_payee_distinct() -> None:
    """Stripping numbers must not collapse every numeric payee into one group."""
    assert merchant_key("4471") == "4471"
    assert merchant_key("4471") != merchant_key("9902")


def test_slug_is_id_safe() -> None:
    assert slug("ONLINE TRANSFER TO ***4471") == "online_transfer_to_4471"


# --- Cadence ------------------------------------------------------------------


def test_detect_cadence_finds_an_exact_fortnight() -> None:
    dates = [WINDOW_START + timedelta(days=14 * i) for i in range(6)]
    cadence = detect_cadence(dates)
    assert cadence is not None
    assert cadence.interval_days == 14
    assert cadence.regularity == 1.0
    assert cadence.occurrences == 6


def test_detect_cadence_needs_more_than_an_anecdote() -> None:
    assert detect_cadence([WINDOW_START, WINDOW_START + timedelta(days=14)]) is None


def test_a_missed_payment_costs_regularity_but_not_the_interval() -> None:
    """The median gap holds at 14 across a skipped payment; regularity pays for it.

    Taking the median gap is what keeps the interval at 14: a mean would read
    the double gap as a cadence of nearly 17 days.
    """
    days = [0, 14, 28, 56, 70, 84]  # the payment at day 42 never arrived.
    cadence = detect_cadence([WINDOW_START + timedelta(days=d) for d in days])
    assert cadence is not None
    assert cadence.interval_days == 14
    assert cadence.regularity < 1.0


# --- Income -------------------------------------------------------------------


def test_detect_income_recovers_amount_cadence_and_next_date() -> None:
    dates = [AS_OF - timedelta(days=14 * i) for i in range(1, 8)]
    paychecks = [txn(d, 700.0, "CAMPUS PAYROLL", "income", i) for i, d in enumerate(dates)]

    (stream,) = detect_income(paychecks, AS_OF)

    assert stream.expected_amount == 700.0
    assert stream.interval_days == 14
    assert stream.uncertainty == 0.0
    assert stream.provenance == "observed"
    # The last paycheck landed on as_of - 14, so the next one is due on as_of - 14 + 14
    # ... which is today, and "next" means still to come.
    assert stream.next_date > AS_OF


def test_an_inbound_transfer_is_not_called_income() -> None:
    """Money arriving without a stated source is not a paycheck (SPEC section 2)."""
    dates = [AS_OF - timedelta(days=14 * i) for i in range(1, 8)]
    assert detect_income([txn(d, 500.0, "ZELLE FROM SAM", "transfer", i) for i, d in enumerate(dates)], AS_OF) == []


def test_an_irregular_deposit_is_not_an_income_stream() -> None:
    days = [0, 3, 40, 41, 110, 180]
    deposits = [txn(WINDOW_START + timedelta(days=d), 200.0, "ODD JOB", "income", d) for d in days]
    assert detect_income(deposits, AS_OF) == []


# --- Obligations --------------------------------------------------------------


def test_detect_monthly_counts_the_chances_the_charge_had() -> None:
    """The denominator is due dates inside the window, not calendar months."""
    dates = [date(2026, month, 1) for month in range(1, 10)]
    monthly = detect_monthly(dates, date(2026, 1, 1), AS_OF)
    assert monthly is not None
    assert monthly.due_day == 1
    assert monthly.months_observed == 9
    assert monthly.months_eligible == 9  # Jan 1 through Sep 1, both in the window.


def test_a_full_year_of_flat_rent_is_confident_but_never_certain() -> None:
    rent = monthly_series(1, 650.0, "HOKIE PROPERTY MGMT RENT", "rent", list(range(1, 10)))
    (obligation,) = detect_obligations(rent, date(2026, 1, 1), AS_OF)[0]

    assert obligation.due_day == 1
    assert obligation.expected_amount == 650.0
    assert obligation.mandatory is True
    assert obligation.confidence == 0.99
    assert obligation.category_candidates == []


def test_skipped_months_lower_confidence_without_moving_the_due_day() -> None:
    patchy = monthly_series(5, 75.0, "ONLINE TRANSFER TO ***4471", "transfer", [1, 3, 4, 7, 9])
    (obligation,) = detect_obligations(patchy, date(2026, 1, 1), AS_OF)[0]

    assert obligation.due_day == 5
    assert obligation.confidence < 0.7


def test_an_opaque_transfer_asks_instead_of_deciding() -> None:
    """Candidates are the app's cue to ask; only the user sets declared_category."""
    transfers = monthly_series(5, 75.0, "ONLINE TRANSFER TO ***4471", "transfer", [1, 3, 4, 7, 9])
    (obligation,) = detect_obligations(transfers, date(2026, 1, 1), AS_OF)[0]

    assert [c.category for c in obligation.category_candidates] == [
        "savings_transfer",
        "debt_repayment",
        "optional_spending",
    ]
    assert obligation.declared_category is None
    assert obligation.mandatory is False


def test_a_named_bill_gets_no_category_question() -> None:
    bills = monthly_series(15, 60.0, "TOWN ELECTRIC UTILITY", "utilities", list(range(1, 10)))
    (obligation,) = detect_obligations(bills, date(2026, 1, 1), AS_OF)[0]
    assert obligation.category_candidates == []


def test_a_subscription_is_not_mandatory() -> None:
    subs = monthly_series(10, 25.0, "SPOTIFY PREMIUM", "subscriptions", list(range(1, 10)))
    (obligation,) = detect_obligations(subs, date(2026, 1, 1), AS_OF)[0]
    assert obligation.mandatory is False


def test_a_merchant_visited_several_times_a_month_is_not_an_obligation() -> None:
    """Groceries recur, but not as a bill; they belong to variable spending."""
    trips = [
        txn(date(2026, month, day), -40.0, "KROGER #418", "groceries", index=month * 100 + day)
        for month in range(1, 10)
        for day in (3, 11, 19, 27)
    ]
    obligations, keys = detect_obligations(trips, date(2026, 1, 1), AS_OF)
    assert obligations == []
    assert keys == set()


# --- Variable spending --------------------------------------------------------


def test_fortnight_blocks_are_whole_and_end_on_as_of() -> None:
    blocks = fortnight_blocks(AS_OF - timedelta(days=30), AS_OF)
    assert len(blocks) == 2  # 30 days holds two whole fortnights, with 2 days left over.
    assert blocks[-1][1] == AS_OF
    assert all((end - start).days == 13 for start, end in blocks)


def test_variable_spending_is_a_fortnightly_mean() -> None:
    """Four $25 trips a fortnight for 26 fortnights averages $100."""
    trips = [
        txn(AS_OF - timedelta(days=14 * block + offset), -25.0, "ALDI MARKET", "groceries", offset)
        for block in range(26)
        for offset in (0, 3, 7, 11)
    ]
    (spending,) = detect_variable_spending(trips, set(), WINDOW_START, AS_OF)

    assert spending.category == "groceries"
    assert spending.mean_14d == pytest.approx(100.0, abs=5.0)
    assert spending.provenance == "observed"


def test_obligations_are_not_counted_twice_as_spending() -> None:
    rent = monthly_series(1, 650.0, "HOKIE PROPERTY MGMT RENT", "rent", list(range(1, 10)))
    assert detect_variable_spending(rent, {"HOKIE PROPERTY MGMT RENT"}, WINDOW_START, AS_OF) == []


def test_income_is_not_counted_as_spending() -> None:
    deposits = [txn(AS_OF - timedelta(days=14 * i), 700.0, "PAYROLL", "income", i) for i in range(5)]
    assert detect_variable_spending(deposits, set(), WINDOW_START, AS_OF) == []


# --- Recovery: the detector against Alex's real feed ---------------------------


@pytest.fixture(scope="module")
def recovered():
    twin = load_seed_twin()
    return detect_structure(normalize_all(load_raw_transactions()), twin.as_of)


def test_the_paycheck_comes_back(recovered) -> None:
    """$720 every 14 days, next on 2026-09-25 — recovered from 26 noisy deposits."""
    expected = load_seed_twin().income[0]
    (stream,) = recovered.income

    assert stream.interval_days == expected.interval_days
    assert stream.next_date == expected.next_date
    assert stream.expected_amount == pytest.approx(expected.expected_amount, abs=40)
    assert stream.uncertainty == pytest.approx(expected.uncertainty, abs=25)
    assert stream.provenance == "observed"


def test_every_obligation_comes_back_on_the_right_day(recovered) -> None:
    expected = {o.due_day: o for o in load_seed_twin().obligations}
    found = {o.due_day: o for o in recovered.obligations}

    assert set(found) == set(expected)
    for due_day, obligation in found.items():
        assert obligation.expected_amount == pytest.approx(
            expected[due_day].expected_amount, rel=0.1
        ), f"amount for the charge due on day {due_day}"
        assert obligation.mandatory == expected[due_day].mandatory


def test_a_reliable_bill_scores_higher_than_a_patchy_one(recovered) -> None:
    by_day = {o.due_day: o for o in recovered.obligations}
    rent, mystery = by_day[1], by_day[5]

    assert rent.confidence > 0.95
    assert 0.4 <= mystery.confidence <= 0.7
    assert mystery.confidence < rent.confidence


def test_only_the_opaque_transfer_raises_a_question(recovered) -> None:
    asking = [o for o in recovered.obligations if o.category_candidates]
    assert [o.due_day for o in asking] == [5]
    assert all(o.declared_category is None for o in recovered.obligations)


def test_spending_distributions_come_back(recovered) -> None:
    """Means land near the twin's; the spread reads high, and that is expected.

    The generator drew each fortnight's spending inside its own 14-day block.
    The detector does not know where those blocks were, so trips land either
    side of its own boundaries and the measured spread exceeds the parameter
    the data was drawn from.
    """
    expected = {v.category: v for v in load_seed_twin().variable_spending}
    found = {v.category: v for v in recovered.variable_spending}

    assert set(found) == set(expected)
    for category, distribution in found.items():
        assert distribution.mean_14d == pytest.approx(expected[category].mean_14d, abs=30)
        assert distribution.std_dev_14d > 0


def test_recovery_invents_no_goals_or_constraints(recovered) -> None:
    """detect_structure returns the observed half only. There is no other half here."""
    assert not hasattr(recovered, "goals")
    assert not hasattr(recovered, "constraints")


def test_an_empty_history_detects_nothing() -> None:
    empty = detect_structure([], AS_OF)
    assert (empty.income, empty.obligations, empty.variable_spending) == ([], [], [])
    assert empty.forecast is None


# --- The forecast behind the spending -----------------------------------------


def test_detected_spending_carries_a_seasonal_profile(recovered) -> None:
    # Groceries only. Whether discretionary gets a profile depends on this seed's
    # draws, and asserting either way would be asserting an artifact of the seed.
    found = {v.category: v for v in recovered.variable_spending}
    assert found["groceries"].seasonal is not None


def test_a_flat_category_carries_no_profile() -> None:
    """A category with no calendar in it comes back flat, not with a fitted shape.

    Synthetic, because the committed feed has no such category: everything it
    leaves outside the obligations is groceries or discretionary, both seasonal.
    The totals wobble in a three-fortnight cycle so the fit has variation to
    work with, but none of it follows the calendar.
    """
    trips = [
        txn(
            AS_OF - timedelta(days=14 * block + offset),
            -(20.0 + 5 * (block % 3)),
            "MISC",
            "other",
            offset,
        )
        for block in range(26)
        for offset in (0, 3, 7, 11)
    ]
    (spending,) = detect_variable_spending(trips, set(), WINDOW_START, AS_OF)
    assert spending.seasonal is None


def test_the_built_twin_records_how_it_forecast() -> None:
    twin = load_seed_twin()
    transactions = normalize_all(load_raw_transactions())
    built = build_twin(
        user_id=twin.user_id,
        display_name=twin.display_name,
        accounts=twin.accounts,
        transactions=transactions,
        as_of=twin.as_of,
        goals=twin.goals,
        constraints=twin.constraints,
    )

    assert built.forecast is not None
    assert built.forecast.method == "seasonal_ewma"
    assert built.forecast.as_of == twin.as_of
    assert built.forecast.window_start == min(t.date for t in transactions)
    assert built.forecast.observed_fortnights == 26
    assert built.forecast.half_life_days == HALF_LIFE_DAYS


def test_a_short_history_stays_flat() -> None:
    """The Nessie path: a freshly seeded account has only a few months of history.

    It must degrade to a plain recency-weighted mean rather than fit a shape to
    a few fortnights, even when those fortnights swing hard.
    """
    trips = [
        txn(
            AS_OF - timedelta(days=14 * block + offset),
            -(10.0 if block < 4 else 60.0),
            "ALDI MARKET",
            "groceries",
            offset,
        )
        for block in range(8)
        for offset in (0, 4, 9, 13)
    ]
    structure = detect_structure(trips, AS_OF)

    assert structure.forecast is not None
    assert structure.forecast.observed_fortnights < MIN_FORTNIGHTS_FOR_SEASONALITY
    assert structure.forecast.method == "flat_mean"
    # No profile, but the mean is still recency-weighted, and the metadata says so.
    assert structure.forecast.half_life_days == HALF_LIFE_DAYS
    assert all(v.seasonal is None for v in structure.variable_spending)
