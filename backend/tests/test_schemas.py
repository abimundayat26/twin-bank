import pytest
from pydantic import ValidationError

from backend.fixtures import load_simulation, load_twin
from backend.schemas import (
    ClarificationResponseRequest,
    DeclaredGoalsRequest,
    FinancialConstraint,
    FinancialObligation,
    FinancialTwin,
    ForecastMetadata,
    GoalCompileRequest,
    GoalCompileResponse,
    MinimumBalanceRequest,
    OptimizationRequest,
    OptimizationResponse,
    ScenarioMetrics,
    SeasonalProfile,
    SimulationResponse,
    SpendingAdjustment,
    VariableSpendingDistribution,
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


BAND = [{"date": "2026-09-19", "p10": 2840.0, "median": 2840.0, "p90": 2840.0}]


def test_balance_bands_are_optional():
    response = load_simulation().model_dump(exclude={"balance_bands"})
    assert SimulationResponse.model_validate(response).balance_bands is None


def test_balance_bands_round_trip():
    scenario = {"total": BAND, "checking": BAND}
    data = {**load_simulation().model_dump(mode="json"), "balance_bands": {
        "baseline": scenario, "counterfactual": scenario,
    }}
    response = SimulationResponse.model_validate(data)
    assert response.balance_bands.counterfactual.total[0].median == 2840.0
    assert SimulationResponse.model_validate_json(response.model_dump_json()) == response


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


# --- Forecast ----------------------------------------------------------------

# A term-time shape: quiet over the summer, busiest in August and December.
TERM_FACTORS = {
    1: 1.0, 2: 0.95, 3: 1.0, 4: 0.95, 5: 0.9, 6: 0.8,
    7: 0.8, 8: 1.3, 9: 1.05, 10: 1.05, 11: 1.0, 12: 1.2,
}

FORECAST = {
    "method": "seasonal_ewma",
    "as_of": "2026-09-19",
    "window_start": "2025-09-20",
    "observed_fortnights": 26,
    "half_life_days": 90.0,
}


def test_seasonal_profile_accepts_twelve_mean_preserving_factors():
    profile = SeasonalProfile(factors=TERM_FACTORS)
    assert sum(profile.factors.values()) / 12 == pytest.approx(1.0)
    assert profile.factors[8] == pytest.approx(1.3)


def test_seasonal_profile_rejects_a_missing_month():
    with pytest.raises(ValidationError):
        SeasonalProfile(factors={m: f for m, f in TERM_FACTORS.items() if m != 7})


def test_seasonal_profile_rejects_a_negative_factor():
    with pytest.raises(ValidationError):
        SeasonalProfile(factors={**TERM_FACTORS, 6: -0.8})


def test_seasonal_profile_rejects_factors_that_do_not_average_one():
    # Every month 30% busier than the average month is a contradiction: it would
    # mean mean_14d no longer describes the average fortnight.
    with pytest.raises(ValidationError):
        SeasonalProfile(factors={m: f * 1.3 for m, f in TERM_FACTORS.items()})


def test_spending_distribution_without_a_seasonal_profile_is_valid():
    spending = VariableSpendingDistribution(category="groceries", mean_14d=150, std_dev_14d=40)
    assert spending.seasonal is None


def test_seasonal_profile_round_trips_through_json_string_keys():
    spending = VariableSpendingDistribution(
        category="groceries", mean_14d=150, std_dev_14d=40,
        seasonal=SeasonalProfile(factors=TERM_FACTORS),
    )
    assert spending.model_dump(mode="json")["seasonal"]["factors"]["8"] == pytest.approx(1.3)
    restored = VariableSpendingDistribution.model_validate_json(spending.model_dump_json())
    assert restored == spending


def test_forecast_metadata_round_trips():
    forecast = ForecastMetadata.model_validate(FORECAST)
    assert forecast.observed_fortnights == 26
    assert ForecastMetadata.model_validate_json(forecast.model_dump_json()) == forecast


def test_forecast_metadata_rejects_an_unknown_method():
    with pytest.raises(ValidationError):
        ForecastMetadata.model_validate({**FORECAST, "method": "crystal_ball"})


@pytest.mark.parametrize(
    "bad", [{"observed_fortnights": -1}, {"half_life_days": 0}, {"half_life_days": -30.0}]
)
def test_forecast_metadata_rejects_impossible_windows(bad):
    with pytest.raises(ValidationError):
        ForecastMetadata.model_validate({**FORECAST, **bad})


def test_flat_mean_forecast_needs_no_half_life():
    forecast = ForecastMetadata.model_validate(
        {**FORECAST, "method": "flat_mean", "half_life_days": None}
    )
    assert forecast.half_life_days is None


def test_twin_forecast_is_optional_and_unset_on_the_fixture():
    twin = load_twin()
    assert twin.forecast is None
    carried = twin.model_copy(update={"forecast": ForecastMetadata.model_validate(FORECAST)})
    assert FinancialTwin.model_validate_json(carried.model_dump_json()) == carried


@pytest.mark.parametrize("source", ["fixture", "nessie", "databricks", None])
def test_twin_source_accepts_every_known_source(source):
    twin = load_twin().model_copy(update={"source": source})
    assert FinancialTwin.model_validate_json(twin.model_dump_json()).source == source


def test_twin_source_rejects_an_unknown_source():
    data = load_twin().model_dump(mode="json") | {"source": "spreadsheet"}
    with pytest.raises(ValidationError):
        FinancialTwin.model_validate(data)
