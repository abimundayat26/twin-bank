"""One regression test for Person 2's complete $800 laptop demo story."""

from datetime import date

from backend.fixtures import load_twin
from backend.schemas import OptimizationRequest, SimulationEvent, SimulationRequest
from backend.simulation import run_simulation
from backend.simulation.optimize import run_optimization


def test_alex_laptop_is_risky_explained_and_has_a_limit_preserving_alternative():
    twin = load_twin()
    laptop = SimulationEvent(
        type="purchase",
        description="Laptop",
        amount=800,
        date=date(2026, 9, 20),
        account_id="acc_checking",
    )

    simulation = run_simulation(
        twin,
        SimulationRequest(user_id="alex", events=[laptop]),
        n_simulations=100,
        seed=42,
    )
    optimization = run_optimization(
        twin,
        OptimizationRequest(user_id="alex", events=[laptop]),
        n_simulations=100,
        seed=42,
    )

    assert simulation.counterfactual.ending_balance < simulation.baseline.ending_balance
    assert simulation.counterfactual.prob_goal_met < simulation.baseline.prob_goal_met
    assert simulation.counterfactual.prob_below_reserve > simulation.baseline.prob_below_reserve
    assert simulation.counterfactual.prob_low_balance > simulation.baseline.prob_low_balance
    assert "Busy spending stretch" in [driver.label for driver in simulation.drivers]

    limit_preserving = [
        candidate for candidate in optimization.candidates if candidate.meets_constraints
    ]
    assert limit_preserving
    assert optimization.recommended_id == limit_preserving[0].id
    assert limit_preserving[0].label in optimization.summary
