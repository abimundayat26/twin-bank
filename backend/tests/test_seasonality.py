"""The seasonal shape in the mock feed.

The feed exists so that things which claim to find structure can be tested on
finding it. Recurrence detection is tested on recovering the seed twin; a
forecast is tested on recovering the seasonal levels, and that is only
meaningful if they are really in the data and really recoverable.

The expected levels come from `twin_seed.json`, the hand-written structure the
generator planted, rather than from `twin.json`, which is what the detector
recovered. Comparing a detector run to its own output would assert nothing.

So the load-bearing test here is `test_the_seasonal_levels_are_recoverable`. It
fails if someone flattens the signal, weakens it past the point a simple
estimator can find it, or adds so many levels that each one runs out of
fortnights to be estimated from.
"""

import statistics
from collections import defaultdict
from datetime import date, timedelta

import pytest

from backend.fixtures import load_raw_transactions, load_seed_twin
from backend.ingest.generate_transactions import SEASONAL_WEIGHTS, seasonal_factor
from backend.ingest.normalize import normalize_all
from backend.ingest.recurrence import BLOCK_DAYS, detect_structure, fortnight_blocks

TWIN = load_seed_twin()
TRANSACTIONS = normalize_all(load_raw_transactions())
SEASONAL_CATEGORIES = sorted(SEASONAL_WEIGHTS)


def month(year: int, m: int) -> tuple[date, date]:
    """A whole calendar month as a (start, end) pair."""
    last = date(year + (m == 12), m % 12 + 1, 1) - timedelta(days=1)
    return date(year, m, 1), last


def normalized(category: str) -> dict[int, float]:
    """The weights as `seasonal_factor` applies them: averaging 1.0."""
    weights = SEASONAL_WEIGHTS[category]
    mean_weight = sum(weights.values()) / len(weights)
    return {m: w / mean_weight for m, w in weights.items()}


# --- The factor itself --------------------------------------------------------


@pytest.mark.parametrize("category", SEASONAL_CATEGORIES)
def test_a_year_of_factors_averages_to_one(category: str) -> None:
    """Mean-preserving: the shape of the year moves, the size of it does not.

    This is what lets the twin keep describing the annual average, and what
    keeps every tolerance that is written against `mean_14d` alive.
    """
    factors = [seasonal_factor(category, *month(2026, m)) for m in range(1, 13)]
    assert statistics.fmean(factors) == pytest.approx(1.0, abs=0.02)


@pytest.mark.parametrize("category", SEASONAL_CATEGORIES)
def test_a_whole_month_gets_its_own_factor(category: str) -> None:
    expected = normalized(category)
    for m in range(1, 13):
        assert seasonal_factor(category, *month(2026, m)) == pytest.approx(expected[m], abs=0.01)


def test_a_block_straddling_two_months_lands_between_them() -> None:
    """Blocks rarely line up with the calendar, and a cliff at the boundary
    would be an artifact of wherever the blocks happen to start."""
    factors = normalized("discretionary")
    august, september = factors[8], factors[9]
    assert august != september

    straddle = seasonal_factor("discretionary", date(2026, 8, 25), date(2026, 9, 7))
    assert min(august, september) < straddle < max(august, september)


def test_a_category_with_no_seasonal_opinion_is_flat() -> None:
    assert seasonal_factor("other", date(2026, 1, 1), date(2026, 1, 14)) == 1.0


def test_the_factor_consumes_no_randomness() -> None:
    """It must not reshuffle the generator's draws; same inputs, same answer."""
    args = ("groceries", date(2026, 9, 1), date(2026, 9, 14))
    assert seasonal_factor(*args) == seasonal_factor(*args)


# --- The signal in the committed feed -----------------------------------------


def spend_by_month(category: str) -> dict[int, float]:
    totals: dict[int, float] = defaultdict(float)
    for t in TRANSACTIONS:
        if t.category == category:
            totals[t.date.month] += abs(t.amount)
    return totals


def test_the_holidays_are_visible_in_the_feed() -> None:
    """December is travel and presents; June is not. If this ever stops being
    obvious in the raw data, there is nothing for a forecast to find."""
    spend = spend_by_month("discretionary")
    assert spend[12] > 2 * spend[6]


def test_the_summer_is_quiet() -> None:
    """Alex is at his parents' over the summer, so he stops buying groceries."""
    spend = spend_by_month("groceries")
    summer = statistics.fmean([spend[6], spend[7], spend[8]])
    term = statistics.fmean([spend[2], spend[3], spend[10], spend[11]])
    assert summer < 0.75 * term


@pytest.mark.parametrize("category", SEASONAL_CATEGORIES)
def test_the_year_still_totals_what_the_twin_says(category: str) -> None:
    """Shape moved, size did not -- the complement of mean-preservation, checked
    against the feed rather than against the factors."""
    expected = next(v for v in TWIN.variable_spending if v.category == category)
    blocks = fortnight_blocks(min(t.date for t in TRANSACTIONS), TWIN.as_of)
    totals = [
        sum(abs(t.amount) for t in TRANSACTIONS if t.category == category and s <= t.date <= e)
        for s, e in blocks
    ]
    assert statistics.fmean(totals) == pytest.approx(expected.mean_14d, rel=0.25)


# --- The one that matters -----------------------------------------------------


def blocks_by_level(category: str) -> dict[float, list[float]]:
    """Fortnight totals, grouped by the seasonal level the generator used.

    A block is attributed to the month its midpoint falls in, which is how a
    forecaster with no knowledge of the generator would have to do it.
    """
    weights = SEASONAL_WEIGHTS[category]
    grouped: dict[float, list[float]] = defaultdict(list)
    for start, end in fortnight_blocks(min(t.date for t in TRANSACTIONS), TWIN.as_of):
        midpoint = start + timedelta(days=BLOCK_DAYS // 2)
        total = sum(
            abs(t.amount) for t in TRANSACTIONS if t.category == category and start <= t.date <= end
        )
        grouped[weights[midpoint.month]].append(total)
    return grouped


@pytest.mark.parametrize("category", SEASONAL_CATEGORIES)
def test_the_seasonal_levels_are_recoverable(category: str) -> None:
    """A simple estimator must get the levels back, in order and roughly right.

    This is the test the whole feature exists for. Twelve free monthly factors
    would fail it: the relative error on a level is the category's coefficient
    of variation over the root of its observation count, so one fortnight per
    month leaves roughly 40% error and the months cannot be told apart. A few
    levels with many fortnights each can be.
    """
    truth = normalized(category)
    grouped = blocks_by_level(category)
    assert len(grouped) >= 2, "a single level is not a seasonal signal"

    overall = statistics.fmean([total for totals in grouped.values() for total in totals])
    estimated, expected = {}, {}
    for raw_level, totals in grouped.items():
        assert len(totals) >= 2, f"level {raw_level} has too few fortnights to estimate"
        estimated[raw_level] = statistics.fmean(totals) / overall
        expected[raw_level] = truth[next(m for m, w in SEASONAL_WEIGHTS[category].items() if w == raw_level)]

    order = sorted(grouped)
    assert [estimated[level] for level in order] == sorted(estimated[level] for level in order), (
        "the estimated levels are out of order, so the signal is lost in the noise"
    )
    for level in order:
        assert estimated[level] == pytest.approx(expected[level], abs=0.25)

    # A signal that survives estimation has to keep most of its spread. Without
    # this, flattening every level to 1.0 would pass every assertion above.
    true_spread = max(expected.values()) - min(expected.values())
    seen_spread = max(estimated.values()) - min(estimated.values())
    assert true_spread > 0.5, "the seasonal levels are too close together to be worth finding"
    assert seen_spread > 0.5 * true_spread


# --- The forecast that recovers it --------------------------------------------

DETECTED = {v.category: v for v in detect_structure(TRANSACTIONS, TWIN.as_of).variable_spending}


def test_the_forecast_recovers_the_groceries_shape() -> None:
    """The forecast, blind to the generator, finds groceries' term/away shape.

    Unlike `test_the_seasonal_levels_are_recoverable`, the forecast is not told
    which months share a level; it has to estimate every month from about two
    fortnights. The committed feed is too noisy for that to come out right month
    by month (April's two fortnights are $53 and $137, so it fits low beside
    June), so this checks the shape on aggregates, never a single month.

    Groceries only. Whether discretionary gets a profile depends on this seed's
    draws, and asserting either way would be asserting an artifact of the seed.
    """
    seasonal = DETECTED["groceries"].seasonal
    assert seasonal is not None

    weights, truth = SEASONAL_WEIGHTS["groceries"], normalized("groceries")
    away = [m for m, w in weights.items() if w == min(weights.values())]
    on_campus = [m for m, w in weights.items() if w == max(weights.values())]
    fitted_away = statistics.fmean(seasonal.factors[m] for m in away)
    fitted_on_campus = statistics.fmean(seasonal.factors[m] for m in on_campus)
    assert fitted_away < fitted_on_campus

    # Without this, flattening every month to 1.0 would pass the ordering above.
    # The bar is well below the true spread on purpose: the forecast shrinks
    # each month toward 1.0 by how noisy its fortnights are, so on one year of
    # history it recovers roughly half the true spread, not all of it.
    true_spread = truth[on_campus[0]] - truth[away[0]]
    seen_spread = fitted_on_campus - fitted_away
    assert seen_spread > 0.3 * true_spread


@pytest.mark.parametrize("category", SEASONAL_CATEGORIES)
def test_the_forecast_keeps_the_annual_average(category: str) -> None:
    """Restates the abs=30 gate in test_recurrence.py, here where seasonality lives,
    so an estimator change that drags the baseline trips in this file too."""
    expected = next(v for v in TWIN.variable_spending if v.category == category)
    assert DETECTED[category].mean_14d == pytest.approx(expected.mean_14d, abs=30)
