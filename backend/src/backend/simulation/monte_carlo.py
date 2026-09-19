"""Monte Carlo layer: sample uncertain inputs, run the deterministic engine, aggregate.

All balance, obligation and goal logic stays in engine.py. This module only
samples amounts from the twin's uncertainty fields and summarizes many runs.

Sampling (every value comes from a FinancialTwin field):
- Each paycheck: Normal(expected_amount, uncertainty), clamped to within
  INCOME_CLAMP_SDS standard deviations and never below 0.
- Each spending category, per 14-day block starting the day after as_of:
  Normal(mean_14d, std_dev_14d), floored at 0, spread evenly over the block.
- Bill amounts and all dates stay fixed. Draws are independent.

Baseline and counterfactual share the same Draws in each run (common random
numbers), so the hypothetical events are the only difference between them.
"""

import random
import statistics
from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import date, timedelta

from backend.schemas import FinancialTwin, SimulationEvent
from backend.simulation.engine import (
    Comparison,
    Draws,
    ScenarioResult,
    SimulationError,
    compare,
    income_dates,
    resolve_horizon_end,
    simulate_scenario,
)

DEFAULT_SIMULATIONS = 1000
MAX_SIMULATIONS = 20_000
INCOME_CLAMP_SDS = 3.0
SPENDING_BLOCK_DAYS = 14


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

    days = [twin.as_of + timedelta(days=i) for i in range(1, (horizon_end - twin.as_of).days + 1)]
    daily_spending = dict.fromkeys(days, 0.0)
    for category in twin.variable_spending:
        for block_start in range(0, len(days), SPENDING_BLOCK_DAYS):
            block_total = sample_spending(rng, category.mean_14d, category.std_dev_14d)
            for d in days[block_start : block_start + SPENDING_BLOCK_DAYS]:
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
    prob_goal_met: float | None  # every evaluated goal met; None if no goal is evaluated
    goal_shortfall: float  # median total shortfall
    goals: list[GoalAggregate]


@dataclass(frozen=True)
class MonteCarloComparison:
    horizon_end: date
    reserve: float
    n_simulations: int
    baseline: ScenarioAggregate
    counterfactual: ScenarioAggregate
    expected: Comparison  # single expected-value run, for dated explanations


def percentile_range(values: list[float]) -> tuple[float, float]:
    if len(values) < 2:
        return values[0], values[0]
    deciles = statistics.quantiles(values, n=10)
    return deciles[0], deciles[-1]


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
) -> MonteCarloComparison:
    """Baseline vs counterfactual over n_simulations paired futures.

    seed=None draws fresh randomness each call; pass a seed for repeatable results.
    """
    validate_simulation_count(n_simulations)
    end = resolve_horizon_end(twin, horizon_end)
    expected = compare(twin, events, end)  # also validates the events
    rng = random.Random(seed)

    baselines, counterfactuals = [], []
    for _, base, cf in simulate_pairs(twin, events, end, n_simulations, rng):
        # Aggregation only uses summary fields, so drop the daily series.
        baselines.append(replace(base, dates=[], checking=[], total=[]))
        counterfactuals.append(replace(cf, dates=[], checking=[], total=[]))

    return MonteCarloComparison(
        horizon_end=end,
        reserve=expected.reserve,
        n_simulations=n_simulations,
        baseline=aggregate(baselines),
        counterfactual=aggregate(counterfactuals),
        expected=expected,
    )
