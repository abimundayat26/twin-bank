import pytest
from pydantic import ValidationError

from backend.fixtures import load_simulation
from backend.schemas import ScenarioMetrics, SimulationResponse

METRICS = {
    "ending_balance": 3000.0,
    "min_balance": 1600.0,
    "prob_low_balance": 0.5,
    "prob_below_reserve": 0.1,
    "goal_shortfall": 0.0,
    "obligations_covered": True,
}


def test_monte_carlo_fields_are_optional():
    metrics = ScenarioMetrics(**METRICS)
    assert metrics.prob_obligations_uncovered is None
    assert metrics.prob_goal_met is None
    assert load_simulation().num_simulations is None


def test_monte_carlo_fields_accept_probabilities():
    metrics = ScenarioMetrics(**METRICS, prob_obligations_uncovered=0.01, prob_goal_met=0.27)
    assert metrics.prob_goal_met == 0.27


@pytest.mark.parametrize("field", ["prob_obligations_uncovered", "prob_goal_met"])
@pytest.mark.parametrize("value", [-0.1, 1.1])
def test_monte_carlo_probabilities_are_bounded(field, value):
    with pytest.raises(ValidationError):
        ScenarioMetrics(**METRICS, **{field: value})


def test_num_simulations_must_be_positive():
    data = load_simulation().model_dump()
    with pytest.raises(ValidationError):
        SimulationResponse.model_validate({**data, "num_simulations": 0})
    assert SimulationResponse.model_validate({**data, "num_simulations": 1000}).num_simulations == 1000
