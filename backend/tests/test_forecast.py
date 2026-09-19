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

# A student's year, the same kind of shape the generator plants: term, a
# single leaving month, and away.
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
def test_pure_noise_gives_a_flat_or_near_flat_profile(cv: float) -> None:
    """Noise with no shape usually gets no profile, and never much of one.

    Asserted as rates over many seeds rather than on one, so it tests the
    shrinkage and not the luck of a draw. Most seeds see no spread beyond what
    noise explains and come back None. The rest are shrunk: nine in ten stay
    inside one fortnight's coefficient of variation of the annual average,
    against the several-CV swings raw monthly means would show.
    """
    effects = []
    for seed in range(200):
        profile = fit_seasonal_factors(shaped({m: 1.0 for m in range(1, 13)}, noise=cv, seed=seed))
        effects.append(0.0 if profile is None else max(abs(f - 1) for f in profile.factors.values()))

    assert sum(e == 0 for e in effects) / len(effects) > 0.5
    assert sorted(effects)[int(0.9 * len(effects))] < cv


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


@pytest.mark.parametrize("seed", range(5))
def test_a_strong_planted_shape_is_recovered(seed: int) -> None:
    profile = fit_seasonal_factors(shaped(SHAPE, noise=0.1, seed=seed))
    assert profile is not None
    term = [m for m, w in RAW_SHAPE.items() if w == TERM]
    away = [m for m, w in RAW_SHAPE.items() if w == AWAY]
    assert min(profile.factors[m] for m in term) > max(profile.factors[m] for m in away)


def test_a_noisier_month_is_shrunk_harder() -> None:
    """Same raw factor, fewer fortnights behind it: pulled closer to 1.0.

    Ending on 19 September, March holds three fortnights and February two. Both
    are planted at 1.5 exactly; the other months wobble so there is noise to
    weigh them against.
    """
    blocks = [
        Fortnight(b.start, b.end, 150.0 if b.month in (2, 3) else (90.0 if i % 2 else 110.0))
        for i, b in enumerate(fortnights([0.0] * 26))
    ]
    assert [b.month for b in blocks].count(3) > [b.month for b in blocks].count(2)

    profile = fit_seasonal_factors(blocks)

    assert profile is not None
    assert profile.factors[3] > profile.factors[2] > 1


def test_one_outlier_fortnight_does_not_move_a_month_to_the_other_season() -> None:
    """One unlucky term-time fortnight drags April down, but not into the summer.

    The case that motivated shrinkage: a single $53 grocery fortnight in April
    was enough for level clustering to file April with the away months.
    """
    blocks = shaped(SHAPE, noise=0.1, seed=1)
    first_april = next(i for i, b in enumerate(blocks) if b.month == 4)
    low = blocks[first_april]
    blocks[first_april] = Fortnight(low.start, low.end, 100 * SHAPE[4] * 0.27)

    profile = fit_seasonal_factors(blocks)

    assert profile is not None
    away = [m for m, w in RAW_SHAPE.items() if w == AWAY]
    assert profile.factors[4] > max(profile.factors[m] for m in away)


def test_more_history_shrinks_less() -> None:
    """The same shape and noise over two years is trusted more than over one."""

    def spread(count: int) -> float:
        blocks = [
            Fortnight(b.start, b.end, b.total * (0.7 if i % 2 else 1.3))
            for i, b in enumerate(shaped(SHAPE, count=count))
        ]
        profile = fit_seasonal_factors(blocks)
        assert profile is not None
        term = statistics.fmean(profile.factors[m] for m, w in RAW_SHAPE.items() if w == TERM)
        away = statistics.fmean(profile.factors[m] for m, w in RAW_SHAPE.items() if w == AWAY)
        return term - away

    planted = TERM - AWAY
    assert spread(26) < spread(52) <= planted * 1.05


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
    variable than a quiet one: constant coefficient of variation. Proportional
    to the fitted factors, which shrinkage keeps a little inside the planted
    2.6x, not to the planted shape itself.
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
    assert busy / quiet == pytest.approx(
        profile.factors[2] / profile.factors[7]
    )
    assert busy / quiet > 2


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
