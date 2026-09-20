"""The mock raw feed must actually contain the structure twin_seed.json describes.

Recurrence detection has to rediscover the paycheck cadence, the monthly bills
and the fortnightly spending distributions from these records. If the fixture
does not contain them, the detector cannot be developed against it — so these
tests check the data, not the code that reads it.

The comparison is against the seed, which is what the generator was fed, not
against `twin.json`, which is what the detector produces from the result.
"""

import statistics
from collections import Counter, defaultdict

from backend.fixtures import load_raw_transactions, load_seed_twin
from backend.ingest import normalize_all
from backend.ingest.generate_transactions import build_feed

TWIN = load_seed_twin()
TRANSACTIONS = normalize_all(load_raw_transactions())


def by_category(category: str):
    return [t for t in TRANSACTIONS if t.category == category]


def fortnight_totals(category: str) -> list[float]:
    """Outflow per 14-day block, aligned to the first transaction in the feed."""
    start = TRANSACTIONS[0].date
    blocks: defaultdict[int, float] = defaultdict(float)
    for transaction in by_category(category):
        blocks[(transaction.date - start).days // 14] += -transaction.amount
    return list(blocks.values())


def test_fixture_is_the_generator_output():
    """The committed fixture is reproducible: regenerate it, do not hand-edit it."""
    generated = build_feed(TWIN)
    committed = [raw.model_dump(by_alias=True, mode="json") for raw in load_raw_transactions()]
    assert [event["_id"] for event in generated] == [event["_id"] for event in committed]
    assert generated == committed


def test_feed_covers_about_a_year_ending_at_as_of():
    span = (TRANSACTIONS[-1].date - TRANSACTIONS[0].date).days
    assert 350 <= span <= 366
    assert TRANSACTIONS[-1].date <= TWIN.as_of


def test_feed_includes_some_unsettled_events():
    """normalize_all has to drop these, so the fixture must contain some."""
    assert any(raw.status != "completed" for raw in load_raw_transactions())


def test_every_transaction_belongs_to_a_twin_account():
    account_ids = {a.id for a in TWIN.accounts}
    assert {t.account_id for t in TRANSACTIONS} <= account_ids


def test_paychecks_match_the_twins_income_stream():
    stream = TWIN.income[0]
    paychecks = by_category("income")
    assert len(paychecks) >= 24, "a year of fortnightly pay"
    gaps = {(b.date - a.date).days for a, b in zip(paychecks, paychecks[1:])}
    assert gaps == {stream.interval_days}
    mean = statistics.mean(t.amount for t in paychecks)
    assert abs(mean - stream.expected_amount) < stream.uncertainty


def test_recurring_bills_land_on_their_due_day():
    for obligation, category in (("obl_rent", "rent"), ("obl_phone", "phone")):
        due_day = next(o.due_day for o in TWIN.obligations if o.id == obligation)
        days = {t.date.day for t in by_category(category)}
        assert days == {due_day}


def test_high_confidence_bills_appear_every_month():
    assert len(by_category("rent")) == 12


def test_the_low_confidence_transfer_is_irregular():
    """It is soft in the twin (confidence 0.55), so it must skip months here."""
    transfers = by_category("transfer")
    assert 4 <= len(transfers) < 12
    assert len({t.date.day for t in transfers}) == 1, "same day of month when it does happen"


def test_variable_spending_matches_the_twins_distributions():
    for distribution in TWIN.variable_spending:
        totals = fortnight_totals(distribution.category)
        assert len(totals) >= 24, f"a year of {distribution.category} blocks"
        mean = statistics.mean(totals)
        # Loose: 26 draws from a wide distribution will not reproduce the mean
        # closely. This checks the fixture is in the right neighbourhood, not
        # that it is a perfect sample.
        assert abs(mean - distribution.mean_14d) < distribution.mean_14d * 0.35


def test_every_category_in_the_twin_is_represented():
    present = Counter(t.category for t in TRANSACTIONS)
    for category in ("income", "rent", "utilities", "phone", "subscriptions", "transfer"):
        assert present[category] > 0
    for distribution in TWIN.variable_spending:
        assert present[distribution.category] > 0
