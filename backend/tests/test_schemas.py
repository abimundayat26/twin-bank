import pytest
from pydantic import ValidationError

from backend.fixtures import load_simulation, load_twin
from backend.schemas import (
    ClarificationResponseRequest,
    DeclaredGoalsRequest,
    FinancialConstraint,
    FinancialObligation,
    GoalCompileRequest,
    GoalCompileResponse,
    MinimumBalanceRequest,
    OptimizationRequest,
    OptimizationResponse,
    ScenarioMetrics,
    SimulationResponse,
    SpendingAdjustment,
)
from backend.simulation.engine import reserve_amount

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
    response = load_simulation().model_dump(exclude={"num_simulations"})
    assert SimulationResponse.model_validate(response).num_simulations is None


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


# --- Obligation categories and twin updates -----------------------------------

OBLIGATION = {
    "id": "obl_x",
    "name": "Transfer",
    "expected_amount": 75.0,
    "due_day": 5,
    "confidence": 0.55,
}


def candidates(*pairs):
    return [{"category": c, "probability": p} for c, p in pairs]


def test_category_fields_default_to_unasked():
    obligation = FinancialObligation(**OBLIGATION)
    assert obligation.category_candidates == []
    assert obligation.declared_category is None
    asked = [o.id for o in load_twin().obligations if o.category_candidates]
    assert asked == ["obl_mystery_transfer"]
    assert all(o.declared_category is None for o in load_twin().obligations)


def test_category_candidates_accept_ordered_probabilities():
    obligation = FinancialObligation(
        **OBLIGATION,
        category_candidates=candidates(
            ("savings_transfer", 0.55), ("debt_repayment", 0.3), ("optional_spending", 0.15)
        ),
        declared_category="savings_transfer",
    )
    assert obligation.category_candidates[0].category == "savings_transfer"
    assert obligation.declared_category == "savings_transfer"


@pytest.mark.parametrize(
    "bad",
    [
        candidates(("bill", 0.5), ("bill", 0.2)),  # duplicate
        candidates(("bill", 0.2), ("savings_transfer", 0.5)),  # not most likely first
        candidates(("bill", 0.7), ("savings_transfer", 0.4)),  # sums above 1
        candidates(("groceries", 0.5)),  # unknown category
        candidates(("bill", 1.5)),  # not a probability
    ],
)
def test_category_candidates_reject_invalid(bad):
    with pytest.raises(ValidationError):
        FinancialObligation(**OBLIGATION, category_candidates=bad)


def test_declared_category_must_be_known():
    with pytest.raises(ValidationError):
        FinancialObligation(**OBLIGATION, declared_category="groceries")


def test_minimum_checking_balance_is_not_the_reserve():
    twin = load_twin()
    checking_floor = FinancialConstraint(
        id="con_min_checking", type="minimum_checking_balance", amount=9999, description="Floor"
    )
    updated = twin.model_copy(update={"constraints": [*twin.constraints, checking_floor]})
    assert reserve_amount(updated) == reserve_amount(twin)


def test_twin_update_requests_validate():
    request = ClarificationResponseRequest(
        user_id="alex", obligation_id="obl_x", category="debt_repayment"
    )
    assert request.category == "debt_repayment"
    with pytest.raises(ValidationError):
        ClarificationResponseRequest(user_id="alex", obligation_id="obl_x", category="rent")
    assert MinimumBalanceRequest(amount=0).amount == 0
    with pytest.raises(ValidationError):
        MinimumBalanceRequest(amount=-1)


# --- Optimization -------------------------------------------------------------

LAPTOP = {
    "type": "purchase",
    "description": "Laptop",
    "amount": 800.0,
    "date": "2026-09-20",
    "account_id": "acc_checking",
}


def optimization_response(**overrides) -> dict:
    candidate = {
        "id": "cand_buy_now",
        "kind": "buy_now",
        "label": "Buy now",
        "detail": "Buy the laptop on 2026-09-20 from checking.",
        "events": [LAPTOP],
        "metrics": METRICS,
        "meets_constraints": True,
    }
    return {
        "optimization_id": "opt_1",
        "user_id": "alex",
        "request": {"user_id": "alex", "events": [LAPTOP]},
        "horizon_end": "2027-05-01",
        "baseline": METRICS,
        "candidates": [candidate],
        "recommended_id": "cand_buy_now",
        "summary": "One option.",
        "assumptions": [],
        "num_simulations": 300,
        **overrides,
    }


def test_optimization_response_round_trips():
    response = OptimizationResponse.model_validate(optimization_response())
    assert OptimizationResponse.model_validate_json(response.model_dump_json()) == response
    assert response.candidates[0].violations == []
    assert response.candidates[0].spending_adjustments == []


def test_optimization_request_needs_an_event():
    with pytest.raises(ValidationError):
        OptimizationRequest(user_id="alex", events=[])


@pytest.mark.parametrize("multiplier", [-0.1, 1.1])
def test_spending_multiplier_is_bounded(multiplier):
    with pytest.raises(ValidationError):
        SpendingAdjustment(category="discretionary", multiplier=multiplier)


def test_unknown_candidate_kind_is_rejected():
    data = optimization_response()
    data["candidates"][0]["kind"] = "take_a_loan"
    with pytest.raises(ValidationError):
        OptimizationResponse.model_validate(data)


# --- Goal compiler -----------------------------------------------------------


def goal_compile_response(**overrides):
    twin = load_twin()
    return {
        "user_id": "alex",
        "text": "I need $2,000 for summer housing by May and want to save for a car",
        "goals": [g.model_dump(mode="json") for g in twin.goals],
        "constraints": [],
        "clarifications": [
            {"field": "amount", "question": "How much do you need for a car?", "fragment": "save for a car"}
        ],
        "unparsed": [],
        "compiler": "rules",
        **overrides,
    }


def test_goal_compile_response_round_trips():
    response = GoalCompileResponse.model_validate(goal_compile_response())
    assert GoalCompileResponse.model_validate_json(response.model_dump_json()) == response
    assert response.goals[0].provenance == "declared"


def test_unknown_clarification_field_is_rejected():
    data = goal_compile_response()
    data["clarifications"][0]["field"] = "mood"
    with pytest.raises(ValidationError):
        GoalCompileResponse.model_validate(data)


@pytest.mark.parametrize("text", ["", "x" * 2001])
def test_goal_text_is_bounded(text):
    with pytest.raises(ValidationError):
        GoalCompileRequest(user_id="alex", text=text)


def test_declared_goals_request_defaults_to_no_constraints():
    request = DeclaredGoalsRequest.model_validate({"goals": []})
    assert request.constraints == []
    twin = load_twin()
    request = DeclaredGoalsRequest(goals=twin.goals, constraints=twin.constraints)
    assert request.goals == twin.goals
