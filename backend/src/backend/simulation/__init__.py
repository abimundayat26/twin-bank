"""Deterministic simulation: baseline vs counterfactual for a FinancialTwin."""

from uuid import uuid4

from backend.schemas import FinancialTwin, ScenarioMetrics, SimulationRequest, SimulationResponse
from backend.simulation.engine import ScenarioResult, SimulationError, compare
from backend.simulation.explain import build_assumptions, build_drivers, build_summary

__all__ = ["SimulationError", "run_simulation", "to_metrics"]


def to_metrics(result: ScenarioResult) -> ScenarioMetrics:
    return ScenarioMetrics(
        ending_balance=result.ending_balance,
        min_balance=result.min_balance,
        prob_low_balance=1.0 if result.dropped_below_low else 0.0,
        prob_below_reserve=1.0 if result.reserve_violated else 0.0,
        goal_shortfall=result.goal_shortfall,
        obligations_covered=result.obligations_covered,
    )


def run_simulation(twin: FinancialTwin, request: SimulationRequest) -> SimulationResponse:
    comparison = compare(twin, request.events, request.horizon_end)
    return SimulationResponse(
        simulation_id=f"sim_{uuid4().hex[:12]}",
        user_id=twin.user_id,
        request=request,
        horizon_end=comparison.horizon_end,
        baseline=to_metrics(comparison.baseline),
        counterfactual=to_metrics(comparison.counterfactual),
        summary=build_summary(twin, request.events, comparison),
        drivers=build_drivers(twin, request.events, comparison),
        assumptions=build_assumptions(twin, comparison),
        is_mock=False,
    )
