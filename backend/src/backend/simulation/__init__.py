"""Monte Carlo simulation: baseline vs counterfactual for a FinancialTwin."""

from uuid import uuid4

from backend.schemas import (
    BalanceBandPoint,
    BalanceBands,
    FinancialTwin,
    ScenarioMetrics,
    SimulationRequest,
    SimulationResponse,
)
from backend.schemas import ScenarioBands as ScenarioBandsSchema
from backend.simulation.engine import SimulationError
from backend.simulation.explain import build_assumptions, build_drivers, build_summary
from backend.simulation.monte_carlo import (
    DEFAULT_SIMULATIONS,
    BandSeries,
    ScenarioAggregate,
    ScenarioBands,
    run_monte_carlo,
)

__all__ = ["SimulationError", "run_simulation", "to_metrics"]


def to_metrics(aggregate: ScenarioAggregate) -> ScenarioMetrics:
    return ScenarioMetrics(
        ending_balance=aggregate.ending_balance,
        min_balance=aggregate.min_balance,
        prob_low_balance=aggregate.prob_low_balance,
        prob_below_reserve=aggregate.prob_below_reserve,
        goal_shortfall=aggregate.goal_shortfall,
        # Conservative: covered only if no simulated future leaves a mandatory bill uncovered.
        obligations_covered=aggregate.prob_obligations_uncovered == 0,
        prob_obligations_uncovered=aggregate.prob_obligations_uncovered,
        prob_savings_sweep=aggregate.prob_savings_sweep,
        prob_goal_met=aggregate.prob_goal_met,
    )


def to_band_points(dates, series: BandSeries) -> list[BalanceBandPoint]:
    return [
        BalanceBandPoint(date=d, p10=low, median=mid, p90=high)
        for d, low, mid, high in zip(dates, series.p10, series.median, series.p90)
    ]


def to_scenario_bands(bands: ScenarioBands) -> ScenarioBandsSchema:
    return ScenarioBandsSchema(
        total=to_band_points(bands.dates, bands.total),
        checking=to_band_points(bands.dates, bands.checking),
    )


def run_simulation(
    twin: FinancialTwin,
    request: SimulationRequest,
    n_simulations: int = DEFAULT_SIMULATIONS,
    seed: int | None = None,
) -> SimulationResponse:
    mc = run_monte_carlo(twin, request.events, request.horizon_end, n_simulations, seed, bands=True)
    return SimulationResponse(
        simulation_id=f"sim_{uuid4().hex[:12]}",
        user_id=twin.user_id,
        request=request,
        horizon_end=mc.horizon_end,
        baseline=to_metrics(mc.baseline),
        counterfactual=to_metrics(mc.counterfactual),
        summary=build_summary(twin, request.events, mc),
        drivers=build_drivers(twin, request.events, mc),
        assumptions=build_assumptions(twin, mc),
        is_mock=False,
        num_simulations=mc.n_simulations,
        balance_bands=BalanceBands(
            baseline=to_scenario_bands(mc.baseline_bands),
            counterfactual=to_scenario_bands(mc.counterfactual_bands),
        ),
    )
