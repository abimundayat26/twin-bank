"""Monte Carlo simulation: baseline vs counterfactual for a FinancialTwin."""

from uuid import uuid4

from backend.schemas import FinancialTwin, ScenarioMetrics, SimulationRequest, SimulationResponse
from backend.simulation.engine import SimulationError
from backend.simulation.explain import build_assumptions, build_drivers, build_summary
from backend.simulation.monte_carlo import DEFAULT_SIMULATIONS, ScenarioAggregate, run_monte_carlo

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
    )


def run_simulation(
    twin: FinancialTwin,
    request: SimulationRequest,
    n_simulations: int = DEFAULT_SIMULATIONS,
    seed: int | None = None,
) -> SimulationResponse:
    mc = run_monte_carlo(twin, request.events, request.horizon_end, n_simulations, seed)
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
    )
