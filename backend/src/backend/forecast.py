"""Fortnight totals -> a recency-weighted baseline and a seasonal profile.

Recurrence detection summarizes a category as one flat `mean_14d` and
`std_dev_14d`, weighting a fortnight from eleven months ago the same as last
fortnight and ignoring the calendar. This module is the replacement estimate:
a per-month `SeasonalProfile` plus a baseline that leans towards recent
fortnights. It is statistics over totals, not inference — no intent, no
randomness, no I/O.

The order of operations is the whole design. The observation window is one
annual cycle, so recency-weighting raw fortnights would down-weight the far half
of that cycle — the very months needed to estimate it — and would confound
"recent" with whichever months happen to be recent. So the seasonal factors are
fitted with every fortnight weighted equally, each fortnight is divided by its
month's factor, and only then is the deseasonalized series recency-weighted.
That is ordinary multiplicative decomposition.

The profile is twelve monthly factors, each shrunk towards 1.0 by how much of
it the data can vouch for. At roughly two fortnights a month a single month's
mean carries about the category's whole coefficient of variation as error, so
twelve raw factors would mostly be noise. Empirical-Bayes shrinkage weighs each
month's raw factor against that noise: a month's factor moves away from 1.0 in
proportion to how far the months as a group spread beyond what noise alone
would produce, and a month backed by fewer fortnights is pulled back harder.
Nothing is assigned to a group, so one unlucky fortnight moves its month a
little rather than moving it to the other season; nothing passes or fails a
gate, so a one-day shift of the window moves the factors a little rather than
switching the profile on or off; and more history shrinks less, on its own.

When the months spread no more than noise would, or the shrunk effect is too
small to matter, the profile is `None` — flat, the same as today — which is also
what a short history (a fresh Nessie account) gets.

The consumer helpers at the bottom are for the simulator, which is why this
module lives outside `ingest/`.
"""

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from backend.schemas import SeasonalProfile

# Below ~10 months of fortnights some months have no observation at all, and a
# factor fitted from part of a year is a guess about the rest of it. Stay flat.
MIN_FORTNIGHTS_FOR_SEASONALITY = 20

# Below this, the largest shrunk monthly effect is not worth modelling: a
# profile whose every month sits within 5% of the annual average says nothing
# the flat mean does not, and "no opinion" should read as None.
MIN_SEASONAL_EFFECT = 0.05

# 180 days gives 26 fortnights an effective sample size of about 18, so the
# baseline's standard error is only ~20% worse than an unweighted mean, while the
# last quarter still counts about twice as much as a year ago. A 60-day half-life
# would leave an effective sample of ~6 and make the baseline jump with every
# unusual fortnight.
HALF_LIFE_DAYS = 180.0


@dataclass(frozen=True)
class Fortnight:
    """One observed block of spending: the days it covers and what left in them."""

    start: date
    end: date
    total: float

    @property
    def month(self) -> int:
        """The calendar month the block's midpoint falls in.

        Same rule as `blocks_by_level` in tests/test_seasonality.py, so the
        estimator and the contract test bucket every block identically.
        """
        return (self.start + timedelta(days=((self.end - self.start).days + 1) // 2)).month


# --- Fitting ------------------------------------------------------------------


def recency_weights(
    blocks: list[Fortnight], as_of: date, half_life_days: float = HALF_LIFE_DAYS
) -> list[float]:
    """Exponential decay by how long ago each block ended."""
    return [0.5 ** (max(0, (as_of - b.end).days) / half_life_days) for b in blocks]


def weighted_mean(values: list[float], weights: list[float]) -> float:
    return sum(v * w for v, w in zip(values, weights)) / sum(weights)


def fit_seasonal_factors(blocks: list[Fortnight]) -> SeasonalProfile | None:
    """Twelve shrunk monthly factors, or None when the calendar does not clearly matter.

    Every block is weighted equally here — see the module docstring for why
    recency must not touch this step.

    Method of moments, per month m with n_m fortnights and raw factor
    r_m = mean_m / M (M the annual mean):

    * noise: s2, the pooled within-month variance of the fortnight totals, so a
      raw factor's own noise variance is v_m = s2 / (M^2 n_m);
    * signal: tau2 = max(0, Var_n(r) - Mean_n(v)), the spread of the raw factors
      beyond what their noise explains, both weighted by n_m;
    * f_m = 1 + tau2 / (tau2 + v_m) * (r_m - 1).

    Weighting both moments by n_m keeps them consistent with each other and makes
    the weighted mean of r_m exactly 1. The subtraction slightly over-corrects
    under pure noise (the mean of r is itself estimated), which errs towards flat.
    """
    if len(blocks) < MIN_FORTNIGHTS_FOR_SEASONALITY:
        return None
    overall = sum(b.total for b in blocks) / len(blocks)
    if overall <= 0:
        return None

    by_month: dict[int, list[float]] = defaultdict(list)
    for block in blocks:
        by_month[block.month].append(block.total)

    within = sum(
        sum((x - sum(xs) / len(xs)) ** 2 for x in xs) for xs in by_month.values() if len(xs) > 1
    )
    dof = sum(len(xs) - 1 for xs in by_month.values() if len(xs) > 1)
    if dof == 0:
        return None
    s2 = within / dof

    months = sorted(by_month)
    counts = {m: len(by_month[m]) for m in months}
    raw = {m: sum(by_month[m]) / counts[m] / overall for m in months}
    noise = {m: s2 / (overall**2 * counts[m]) for m in months}
    total = sum(counts.values())
    spread = sum(counts[m] * (raw[m] - 1) ** 2 for m in months) / total
    expected_noise = sum(counts[m] * noise[m] for m in months) / total
    tau2 = max(0.0, spread - expected_noise)
    if tau2 == 0:
        return None

    # A month with no observation has nothing to say, so it stays at the annual
    # average.
    factors = {m: 1.0 for m in range(1, 13)}
    for m in months:
        factors[m] = 1 + tau2 / (tau2 + noise[m]) * (raw[m] - 1)
    if max(abs(f - 1) for f in factors.values()) < MIN_SEASONAL_EFFECT:
        return None
    # Mean-preserving, as SeasonalProfile requires: mean_14d stays the
    # annual-average fortnight.
    scale = sum(factors.values()) / 12
    return SeasonalProfile(factors={m: round(f / scale, 4) for m, f in factors.items()})


def fit_baseline(
    blocks: list[Fortnight],
    as_of: date,
    profile: SeasonalProfile | None,
    half_life_days: float = HALF_LIFE_DAYS,
) -> tuple[float, float]:
    """Recency-weighted mean and spread of the deseasonalized fortnights.

    Both come back on the deseasonalized scale: the annual-average fortnight and
    its spread. The consumer multiplies both by the block's factor, so a busy
    month is proportionally more variable — constant coefficient of variation,
    which is how the generator applies its own seasonality.

    The spread uses the reliability-weights correction, Σw(x-μ)² / (Σw - Σw²/Σw),
    which reduces to the ordinary sample variance when every weight is equal.
    """
    if not blocks:
        return 0.0, 0.0
    # Bucketed by midpoint, the same way the factors were fitted.
    factors = [profile.factors[b.month] if profile else 1.0 for b in blocks]
    values = [b.total / f if f > 0 else 0.0 for b, f in zip(blocks, factors)]
    weights = recency_weights(blocks, as_of, half_life_days)
    mean = weighted_mean(values, weights)
    total_weight = sum(weights)
    denominator = total_weight - sum(w * w for w in weights) / total_weight
    if denominator <= 0:
        return mean, 0.0
    variance = sum(w * (v - mean) ** 2 for v, w in zip(values, weights)) / denominator
    return mean, math.sqrt(variance)


def fit_category(
    blocks: list[Fortnight], as_of: date, half_life_days: float = HALF_LIFE_DAYS
) -> tuple[float, float, SeasonalProfile | None]:
    """`(mean_14d, std_dev_14d, seasonal)` for one category's fortnights."""
    profile = fit_seasonal_factors(blocks)
    mean, spread = fit_baseline(blocks, as_of, profile, half_life_days)
    return mean, spread, profile


# --- Consuming a profile ------------------------------------------------------
#
# Estimation attributes a block to the month its midpoint falls in; application
# averages the factor over the block's days. The asymmetry is deliberate: the
# midpoint is how an observation is bucketed, and averaging is how a factor is
# applied without a cliff at a month boundary that exists only because of where
# the blocks happen to start. It matches `seasonal_factor` in the generator.


def month_factor(profile: SeasonalProfile | None, day: date) -> float:
    """The multiplier on mean and spread for a single day. No profile, no change."""
    if profile is None:
        return 1.0
    return profile.factors[day.month]


def block_factor(profile: SeasonalProfile | None, start: date, days: int = 14) -> float:
    """The multiplier for a block of `days` days starting on `start`."""
    if profile is None:
        return 1.0
    return sum(month_factor(profile, start + timedelta(days=i)) for i in range(days)) / days
