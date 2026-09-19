"""Monte Carlo layer: sample uncertain inputs, run the deterministic engine, aggregate.

All balance, obligation and goal logic stays in engine.py. This module only
samples amounts from the twin's uncertainty fields and summarizes many runs.

Sampling (every value comes from a FinancialTwin field):
- Each paycheck: Normal(expected_amount, uncertainty), clamped to within
  INCOME_CLAMP_SDS standard deviations and never below 0.
- Each spending category, per 14-day block starting the day after as_of:
  Normal(mean_14d, std_dev_14d), floored at 0, spread evenly over the block.
  With a seasonal profile, the mean and spread are both scaled by the block's
  factor (its month factors averaged over its days), the same blocks and factor
  the deterministic engine uses for its expected spending.
- Bill amounts and all dates stay fixed. Draws are independent.

Baseline and counterfactual share the same Draws in each run (common random
numbers), so the hypothetical events are the only difference between them.
"""

import random
import statistics
from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import date

from backend.forecast import block_factor
from backend.schemas import FinancialTwin, SimulationEvent
from backend.simulation.engine import (
    Comparison,
    Draws,
    ScenarioResult,
    SPENDING_BLOCK_DAYS,
    SimulationError,
    compare,
    income_dates,
    resolve_horizon_end,
    simulate_scenario,
    spending_blocks,
)

DEFAULT_SIMULATIONS = 1000
MAX_SIMULATIONS = 20_000
INCOME_CLAMP_SDS = 3.0


def sample_income(rng: random.Random, mean: float, sd: float) -> float:
    """One paycheck: normal, clamped symmetrically (so the mean is kept) and at 0."""
    x = rng.gauss(mean, sd)
    return max(0.0, mean - INCOME_CLAMP_SDS * sd, min(x, mean + INCOME_CLAMP_SDS * sd))


def sample_spending(rng: random.Random, mean: float, sd: float) -> float:
    """One 14-day block of a spending category: normal, floored at 0.

    Flooring raises the mean slightly (e.g. mean 110, sd 65 becomes about 111.2).
    """
    return max(0.0, rng.gauss(mean, sd))


def sample_draws(twin: FinancialTwin, horizon_end: date, rng: random.Random) -> Draws:
    income = {}
    for stream in twin.income:
        for d in income_dates(stream.next_date, stream.interval_days, twin.as_of, horizon_end):
            income[(stream.id, d)] = sample_income(rng, stream.expected_amount, stream.uncertainty)

    blocks = spending_blocks(twin.as_of, horizon_end)
    daily_spending = {d: 0.0 for block in blocks for d in block}
    for category in twin.variable_spending:
        for block in blocks:
            factor = block_factor(category.seasonal, block[0], len(block))
            block_total = sample_spending(rng, category.mean_14d * factor, category.std_dev_14d * factor)
            for d in block:
                daily_spending[d] += block_total / SPENDING_BLOCK_DAYS
    return Draws(income=income, daily_spending=daily_spending)


def simulate_pairs(
    twin: FinancialTwin,
    events: list[SimulationEvent],
    horizon_end: date,
    n_simulations: int,
    rng: random.Random,
) -> Iterator[tuple[Draws, ScenarioResult, ScenarioResult]]:
    """Yield (draws, baseline, counterfactual) per run; both scenarios share the draws."""
    for _ in range(n_simulations):
        draws = sample_draws(twin, horizon_end, rng)
        yield (
            draws,
            simulate_scenario(twin, [], horizon_end, draws),
            simulate_scenario(twin, events, horizon_end, draws),
        )


@dataclass(frozen=True)
class GoalAggregate:
    goal_id: str
    name: str
    target_amount: float
    deadline: date
    median_available: float
    median_shortfall: float
    prob_met: float


@dataclass(frozen=True)
class ScenarioAggregate:
    ending_balance: float  # median
    ending_balance_p10: float
    ending_balance_p90: float
    min_balance: float  # median of each run's lowest total
    min_checking: float  # median of each run's lowest checking
    prob_low_balance: float
    prob_below_reserve: float
    prob_obligations_uncovered: float
    prob_savings_sweep: float  # savings had to cover a mandatory bill checking could not
    prob_savings_overdrawn: float  # a purchase took savings below $0
    prob_goal_met: float | None  # every evaluated goal met; None if no goal is evaluated
    goal_shortfall: float  # median total shortfall
    goals: list[GoalAggregate]


@dataclass(frozen=True)
class BandSeries:
    """Per-day percentiles of one balance across runs, aligned with ScenarioBands.dates."""

    p10: list[float]
    median: list[float]
    p90: list[float]


@dataclass(frozen=True)
class ScenarioBands:
    dates: list[date]  # as_of, then each simulated day
    total: BandSeries
    checking: BandSeries


@dataclass(frozen=True)
class MonteCarloComparison:
    horizon_end: date
    reserve: float
    n_simulations: int
    baseline: ScenarioAggregate
    counterfactual: ScenarioAggregate
    expected: Comparison  # single expected-value run, for dated explanations
    baseline_bands: ScenarioBands | None = None  # only when run with bands=True
    counterfactual_bands: ScenarioBands | None = None


def percentile_range(values: list[float]) -> tuple[float, float]:
    if len(values) < 2:
        return values[0], values[0]
    deciles = statistics.quantiles(values, n=10)
    return deciles[0], deciles[-1]


def band_series(series: list[list[float]]) -> BandSeries:
    """series[run][day] -> p10/median/p90 per day."""
    p10, median, p90 = [], [], []
    for day_values in zip(*series):
        low, high = percentile_range(list(day_values))
        p10.append(round(low, 2))
        median.append(round(statistics.median(day_values), 2))
        p90.append(round(high, 2))
    return BandSeries(p10=p10, median=median, p90=p90)


def scenario_bands(results: list[ScenarioResult]) -> ScenarioBands:
    return ScenarioBands(
        dates=results[0].dates,
        total=band_series([r.total for r in results]),
        checking=band_series([r.checking for r in results]),
    )


def aggregate(results: list[ScenarioResult]) -> ScenarioAggregate:
    n = len(results)
    endings = [r.ending_balance for r in results]
    p10, p90 = percentile_range(endings)

    goals = []
    for i, first in enumerate(results[0].goals):
        outcomes = [r.goals[i] for r in results]
        goals.append(
            GoalAggregate(
                goal_id=first.goal_id,
                name=first.name,
                target_amount=first.target_amount,
                deadline=first.deadline,
                median_available=round(statistics.median(g.available for g in outcomes), 2),
                median_shortfall=round(statistics.median(g.shortfall for g in outcomes), 2),
                prob_met=sum(g.shortfall == 0 for g in outcomes) / n,
            )
        )

    return ScenarioAggregate(
        ending_balance=round(statistics.median(endings), 2),
        ending_balance_p10=round(p10, 2),
        ending_balance_p90=round(p90, 2),
        min_balance=round(statistics.median(r.min_balance for r in results), 2),
        min_checking=round(statistics.median(r.min_checking for r in results), 2),
        prob_low_balance=sum(r.dropped_below_low for r in results) / n,
        prob_below_reserve=sum(r.reserve_violated for r in results) / n,
        prob_obligations_uncovered=sum(not r.obligations_covered for r in results) / n,
        prob_savings_sweep=sum(bool(r.savings_sweeps) for r in results) / n,
        prob_savings_overdrawn=sum(r.savings_overdrawn for r in results) / n,
        prob_goal_met=sum(r.goal_shortfall == 0 for r in results) / n if goals else None,
        goal_shortfall=round(statistics.median(r.goal_shortfall for r in results), 2),
        goals=goals,
    )


def validate_simulation_count(n_simulations: int) -> None:
    if (
        not isinstance(n_simulations, int)
        or isinstance(n_simulations, bool)
        or not 1 <= n_simulations <= MAX_SIMULATIONS
    ):
        raise SimulationError(f"n_simulations must be an integer from 1 to {MAX_SIMULATIONS}")


def run_monte_carlo(
    twin: FinancialTwin,
    events: list[SimulationEvent],
    horizon_end: date | None = None,
    n_simulations: int = DEFAULT_SIMULATIONS,
    seed: int | None = None,
    bands: bool = False,
) -> MonteCarloComparison:
    """Baseline vs counterfactual over n_simulations paired futures.

    seed=None draws fresh randomness each call; pass a seed for repeatable results.
    bands=True also returns per-day balance percentiles (for charts); it keeps every
    run's daily series in memory, so leave it off when only the metrics are needed.
    """
    validate_simulation_count(n_simulations)
    end = resolve_horizon_end(twin, horizon_end)
    expected = compare(twin, events, end)  # also validates the events
    rng = random.Random(seed)

    baselines, counterfactuals = [], []
    for _, base, cf in simulate_pairs(twin, events, end, n_simulations, rng):
        if not bands:
            # Aggregation only uses summary fields, so drop the daily series.
            base = replace(base, dates=[], checking=[], total=[])
            cf = replace(cf, dates=[], checking=[], total=[])
        baselines.append(base)
        counterfactuals.append(cf)

    return MonteCarloComparison(
        horizon_end=end,
        reserve=expected.reserve,
        n_simulations=n_simulations,
        baseline=aggregate(baselines),
        counterfactual=aggregate(counterfactuals),
        expected=expected,
        baseline_bands=scenario_bands(baselines) if bands else None,
        counterfactual_bands=scenario_bands(counterfactuals) if bands else None,
    )
