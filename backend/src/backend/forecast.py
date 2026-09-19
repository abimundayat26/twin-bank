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

The profile is a few shared levels, never twelve free factors: at roughly two
fortnights per month a single month's mean carries about the category's whole
coefficient of variation as error, so twelve free factors would mostly be
noise. A handful of levels, each backed by several fortnights, can be estimated.
When no such structure passes the guardrails the profile is `None` — flat, the
same as today — which is also what a short history (a fresh Nessie account)
gets.

The consumer helpers at the bottom are for the simulator, which is why this
module lives outside `ingest/`.
"""

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from backend.schemas import SeasonalProfile

# Below ~10 months of fortnights some months have no observation at all, and a
# level fitted from part of a year is a guess about the rest of it. Stay flat.
MIN_FORTNIGHTS_FOR_SEASONALITY = 20

# A level must rest on at least this many fortnights. Two is the most a single
# month holds, and the generator plants single-month levels (May for groceries,
# December for discretionary), so anything higher forbids a shape the data is
# known to have. On the committed feed 2, 3 and 4 fit groceries identically;
# noise is kept out by MIN_VARIANCE_EXPLAINED, not by this.
MIN_FORTNIGHTS_PER_LEVEL = 2

# More levels than this cannot be supported by one year of fortnights.
MAX_LEVELS = 3

# The highest level must sit at least this far above the lowest, as a fraction
# of the annual mean: a floor on an effect worth modelling at all. It is not the
# noise guard — the spread k-means finds in pure noise grows with the noise, so
# at a real category's variability noise clears any fixed spread worth setting.
MIN_LEVEL_SPREAD = 0.25

# The noise guard: the levels must explain at least this share of the variance
# of the fortnight totals. Unlike a spread, this does not scale with how noisy
# the category is — for 26 fortnights of pure noise, the best three-way grouping
# of the months explains a median 39% and a 95th percentile 60%, whatever the
# noise level. So 0.60 lets about one noise-only category in twenty through,
# and keeps groceries-shaped seasonality about nineteen times in twenty.
MIN_VARIANCE_EXPLAINED = 0.60

# 180 days gives 26 fortnights an effective sample size of about 18, so the
# baseline's standard error is only ~20% worse than an unweighted mean, while the
# last quarter still counts about twice as much as a year ago. A 60-day half-life
# would leave an effective sample of ~6 and make the baseline jump with every
# unusual fortnight.
HALF_LIFE_DAYS = 180.0

# k-means over twelve one-dimensional points converges in a handful of steps;
# the cap only guarantees termination.
KMEANS_MAX_ITERATIONS = 50


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


def quantile_centroids(points: list[float], k: int) -> list[float] | None:
    """Starting centroids at the (i + 0.5)/k quantiles of the distinct points.

    Deterministic, so the same input always lands in the same place. Distinct
    rather than weighted: weighting the start would let one heavy level claim
    two centroids, one of which then empties, and a real third level (a single
    month, say) would never be tried.
    """
    distinct = sorted(set(points))
    if len(distinct) < k:
        return None
    return [distinct[int((i + 0.5) * len(distinct) / k)] for i in range(k)]


def kmeans_1d(points: list[float], weights: list[float], k: int) -> list[int] | None:
    """Weighted 1-D k-means; each point's cluster index, or None if a cluster emptied."""
    centroids = quantile_centroids(points, k)
    if centroids is None:
        return None
    labels: list[int] = []
    for _ in range(KMEANS_MAX_ITERATIONS):
        new_labels = [
            min(range(k), key=lambda c: (abs(p - centroids[c]), c)) for p in points
        ]
        if new_labels == labels:
            break
        labels = new_labels
        for c in range(k):
            members = [i for i, label in enumerate(labels) if label == c]
            if not members:
                return None
            centroids[c] = weighted_mean([points[i] for i in members], [weights[i] for i in members])
    return labels


def fit_seasonal_factors(blocks: list[Fortnight]) -> SeasonalProfile | None:
    """A few shared monthly levels, or None when the calendar does not clearly matter.

    Every block is weighted equally here — see the module docstring for why
    recency must not touch this step.

    Each month's raw factor is its mean fortnight over the annual mean, and the
    months are clustered on it, weighted by how many fortnights each holds. That
    weighting makes a cluster's centroid exactly its fortnights' mean over the
    annual mean, so the level is estimated from fortnights, not from months.

    The largest number of levels that passes all three guards wins: enough
    fortnights behind every level, levels far enough apart to matter, and enough
    of the variation explained that it is unlikely to be noise.
    """
    if len(blocks) < MIN_FORTNIGHTS_FOR_SEASONALITY:
        return None
    overall = sum(b.total for b in blocks) / len(blocks)
    total_variation = sum((b.total - overall) ** 2 for b in blocks)
    if overall <= 0 or total_variation == 0:
        return None

    by_month: dict[int, list[float]] = defaultdict(list)
    for block in blocks:
        by_month[block.month].append(block.total)
    months = sorted(by_month)
    raw = [sum(by_month[m]) / len(by_month[m]) / overall for m in months]
    counts = [float(len(by_month[m])) for m in months]

    for k in range(min(MAX_LEVELS, len(months)), 1, -1):
        labels = kmeans_1d(raw, counts, k)
        if labels is None:
            continue
        support = [sum(n for n, label in zip(counts, labels) if label == c) for c in range(k)]
        levels = [
            weighted_mean(
                [r for r, label in zip(raw, labels) if label == c],
                [n for n, label in zip(counts, labels) if label == c],
            )
            for c in range(k)
        ]
        level_of = dict(zip(months, (levels[label] for label in labels)))
        unexplained = sum((b.total - level_of[b.month] * overall) ** 2 for b in blocks)
        if (
            min(support) < MIN_FORTNIGHTS_PER_LEVEL
            or max(levels) - min(levels) < MIN_LEVEL_SPREAD
            or 1 - unexplained / total_variation < MIN_VARIANCE_EXPLAINED
        ):
            continue
        # A month with no observation has nothing to say about its level, so it
        # stays at the annual average.
        factors = {m: level_of.get(m, 1.0) for m in range(1, 13)}
        # Mean-preserving, as SeasonalProfile requires: mean_14d stays the
        # annual-average fortnight.
        scale = sum(factors.values()) / 12
        return SeasonalProfile(factors={m: round(f / scale, 4) for m, f in factors.items()})
    return None


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
