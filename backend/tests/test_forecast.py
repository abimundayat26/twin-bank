"""The forecast estimator, on synthetic fortnights with a known answer.

No fixtures here: each test plants exactly the structure it checks for, so a
failure points at the estimator rather than at a draw of the mock feed.
Recovering the feed's own seasonal levels is a separate, feed-level assertion.
"""

import random
import statistics
from datetime import date, timedelta

import pytest

from backend.forecast import (
    MAX_LEVELS,
    Fortnight,
    block_factor,
    fit_baseline,
    fit_category,
    fit_seasonal_factors,
    month_factor,
    recency_weights,
)
from backend.schemas import SeasonalProfile

AS_OF = date(2026, 9, 19)

# A student's year, the same kind of shape the generator plants: three levels,
# the middle one held by a single month.
TERM, LEAVING, AWAY = 1.3, 0.9, 0.5
RAW_SHAPE = {
    1: TERM, 2: TERM, 3: TERM, 4: TERM, 5: LEAVING, 6: AWAY,
    7: AWAY, 8: AWAY, 9: TERM, 10: TERM, 11: TERM, 12: AWAY,
}
SHAPE = {m: w / statistics.fmean(RAW_SHAPE.values()) for m, w in RAW_SHAPE.items()}


def fortnights(totals: list[float], as_of: date = AS_OF) -> list[Fortnight]:
    """Consecutive 14-day blocks ending on `as_of`, oldest first."""
    count = len(totals)
    blocks = []
    for index, total in enumerate(totals):
        end = as_of - timedelta(days=14 * (count - 1 - index))
        blocks.append(Fortnight(end - timedelta(days=13), end, total))
    return blocks


def shaped(
    shape: dict[int, float], count: int = 26, noise: float = 0.0, seed: int = 0
) -> list[Fortnight]:
    """A year of fortnights around an annual mean of 100, following `shape`.

    Noise is multiplicative, so the coefficient of variation is the same in
    every month, as it is in the generator.
    """
    rng = random.Random(seed)
    return [
        Fortnight(b.start, b.end, 100 * shape[b.month] * max(0.0, rng.gauss(1, noise)))
        for b in fortnights([0.0] * count)
    ]


# --- Whether there is a profile at all ----------------------------------------


def test_a_flat_history_gets_no_seasonal_profile() -> None:
    assert fit_seasonal_factors(fortnights([100.0] * 26)) is None


@pytest.mark.parametrize("cv", [0.1, 0.35, 0.6])
def test_pure_noise_does_not_produce_levels(cv: float) -> None:
    """Noise with no shape must almost never be given one, however noisy it is.

    Asserted as a rate over many seeds rather than on one, so it tests the
    guard and not the luck of a draw. The noisiest case matters most: that is
    where a guard based on how far apart the levels sit would give way.
    """
    seeds = range(200)
    profiled = sum(
        fit_seasonal_factors(shaped({m: 1.0 for m in range(1, 13)}, noise=cv, seed=s)) is not None
        for s in seeds
    )
    assert profiled / len(seeds) < 0.10


def test_a_short_history_stays_flat() -> None:
    """Even a loud shape is not trusted from under half a year of fortnights."""
    assert fit_seasonal_factors(shaped(SHAPE, count=12)) is None


# --- The shape of a profile ---------------------------------------------------


@pytest.mark.parametrize("seed", range(5))
def test_the_fitted_factors_average_to_one(seed: int) -> None:
    """Whatever this module emits, SeasonalProfile's validator accepts."""
    profile = fit_seasonal_factors(shaped(SHAPE, noise=0.1, seed=seed))
    assert profile is not None
    assert statistics.fmean(profile.factors.values()) == pytest.approx(1.0, abs=0.01)


def test_months_at_the_same_level_get_the_same_factor() -> None:
    profile = fit_seasonal_factors(shaped(SHAPE))
    assert profile is not None
    for level in set(RAW_SHAPE.values()):
        months = [m for m, w in RAW_SHAPE.items() if w == level]
        assert len({profile.factors[m] for m in months}) == 1
        assert profile.factors[months[0]] == pytest.approx(SHAPE[months[0]], abs=0.001)


def test_the_number_of_levels_is_capped() -> None:
    """Five planted levels still come back as at most MAX_LEVELS."""
    five = {1: 0.4, 2: 0.4, 3: 0.7, 4: 0.7, 5: 1.0, 6: 1.0, 7: 1.0, 8: 1.3, 9: 1.3, 10: 1.6,
            11: 1.6, 12: 1.6}
    profile = fit_seasonal_factors(shaped(five))
    assert profile is not None
    assert 2 <= len(set(profile.factors.values())) <= MAX_LEVELS


# --- The baseline -------------------------------------------------------------


def test_recency_weighting_follows_a_step_change() -> None:
    """Fails if recency weighting is quietly dropped: a flat mean says exactly 150.

    Called with no profile on purpose. Within a single year a step is
    indistinguishable from a seasonal shape, so the seasonal fit would absorb it;
    this test is about the weighting alone.
    """
    mean, _ = fit_baseline(fortnights([100.0] * 13 + [200.0] * 13), AS_OF, None)
    assert 150 < mean < 200


def test_recency_weighting_does_not_move_a_stationary_series() -> None:
    mean, _ = fit_baseline(fortnights([90.0, 110.0] * 13), AS_OF, None)
    assert mean == pytest.approx(100, abs=0.5)


def test_deseasonalizing_before_weighting_removes_the_calendar_confound() -> None:
    """The one ordering decision in the module, checked directly.

    The feed ends in September, so the most recent fortnights are mostly the
    quiet summer. A recency-weighted mean of the raw totals mistakes that for a
    drop in spending. Taking the calendar out first, with every month weighted
    equally, leaves nothing for recency to confuse, and the baseline lands back
    on the annual mean. There is no trend here at all.
    """
    blocks = shaped(SHAPE)
    weights = recency_weights(blocks, AS_OF)
    naive = sum(w * b.total for w, b in zip(weights, blocks)) / sum(weights)

    mean, _, profile = fit_category(blocks, AS_OF)

    assert profile is not None
    assert mean == pytest.approx(100, rel=0.05)
    assert naive != pytest.approx(100, rel=0.05)


def test_the_spread_scales_with_the_level() -> None:
    """The spread comes back on the deseasonalized scale, and scales with the factor.

    Every fortnight is 10% either side of its month's level, so the
    deseasonalized spread is about 10 — far below the raw spread, which the
    seasonal swings inflate. Applied back, a busy month is proportionally more
    variable than a quiet one: constant coefficient of variation.
    """
    blocks = [
        Fortnight(b.start, b.end, b.total * (0.9 if i % 2 else 1.1))
        for i, b in enumerate(shaped(SHAPE))
    ]
    _, spread, profile = fit_category(blocks, AS_OF)

    assert profile is not None
    assert spread == pytest.approx(10, rel=0.2)
    assert statistics.stdev(b.total for b in blocks) > 2 * spread
    busy = spread * month_factor(profile, date(2026, 2, 1))
    quiet = spread * month_factor(profile, date(2026, 7, 1))
    assert busy / quiet == pytest.approx(TERM / AWAY, rel=0.05)


# --- Consuming a profile ------------------------------------------------------


def test_a_missing_profile_applies_no_factor() -> None:
    assert month_factor(None, date(2026, 12, 15)) == 1.0
    assert block_factor(None, date(2026, 12, 15)) == 1.0


def test_a_block_straddling_two_months_lands_between_them() -> None:
    """Seven days of August and seven of September: halfway, not a cliff."""
    factors = {m: 1.0 for m in range(1, 13)} | {8: 0.5, 9: 1.5}
    profile = SeasonalProfile(factors=factors)

    straddling = block_factor(profile, date(2026, 8, 25))

    assert 0.5 < straddling < 1.5
    assert straddling == pytest.approx(1.0)
