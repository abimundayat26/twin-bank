import re
from datetime import date
from pathlib import Path

import pytest
from pydantic import ValidationError

from backend.fixtures import load_simulation, load_twin
from backend.schemas import (
    AddGoalProposal,
    AddObligationProposal,
    AssistantMessageRequest,
    AssistantMessageResponse,
    AssistantOpening,
    AssistantQuestion,
    CategoryOption,
    ClarificationResponseRequest,
    ClassifyObligationProposal,
    CommitPurchaseRequest,
    CommitPurchaseResponse,
    EarliestDateRequest,
    EarliestDateResponse,
    ForecastCallout,
    ForecastPayload,
    GoalChanges,
    GoalDateChange,
    ObligationsPayload,
    OneTimeObligationChanges,
    OneTimeObligationCreate,
    OneTimeObligationRow,
    OverviewAccount,
    OverviewPayload,
    ProposalBase,
    ProposalDecisionRequest,
    ProposalDecisionResponse,
    RecurringObligationChanges,
    RecurringObligationCreate,
    RecurringObligationRow,
    ReserveRequest,
    SetConstraintProposal,
    SimulatePrefill,
    SpendingSlice,
    UpcomingItem,
    UpdateGoalProposal,
    UpdateObligationProposal,
    DeclaredGoalsRequest,
    FinancialConstraint,
    FinancialObligation,
    FinancialTwin,
    ForecastMetadata,
    GoalCompileRequest,
    GoalCompileResponse,
    MinimumBalanceRequest,
    OneTimeObligation,
    OptimizationRequest,
    OptimizationResponse,
    ProcessingLineage,
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
    assert asked == ["obl_online_transfer_to"]
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


def test_twin_forecast_is_optional_but_recorded_on_the_fixture():
    """Optional in the schema, because a Nessie twin with a few months of history
    may have nothing worth recording. Present on the demo fixture, because that
    one was rebuilt from a year of transactions and can say how."""
    twin = load_twin()
    assert twin.forecast is not None
    assert FinancialTwin.model_validate_json(twin.model_dump_json()) == twin
    assert twin.model_copy(update={"forecast": None}).forecast is None


@pytest.mark.parametrize("source", ["fixture", "nessie", "databricks", None])
def test_twin_source_accepts_every_known_source(source):
    twin = load_twin().model_copy(update={"source": source})
    assert FinancialTwin.model_validate_json(twin.model_dump_json()).source == source


def test_twin_source_rejects_an_unknown_source():
    data = load_twin().model_dump(mode="json") | {"source": "spreadsheet"}
    with pytest.raises(ValidationError):
        FinancialTwin.model_validate(data)


# --- One-time obligations ------------------------------------------------------

TUITION = {
    "id": "one_tuition",
    "name": "Spring tuition",
    "amount": 1200.0,
    "due_date": "2027-01-15",
    "account_id": "acc_checking",
    "mandatory": True,
}


def test_one_time_obligation_round_trips():
    obligation = OneTimeObligation.model_validate(TUITION)
    assert obligation.mandatory is True
    assert obligation.provenance == "declared"
    assert OneTimeObligation.model_validate_json(obligation.model_dump_json()) == obligation


def test_one_time_obligation_is_always_declared():
    """It comes from the user, so nothing may label it as read off banking data."""
    with pytest.raises(ValidationError):
        OneTimeObligation.model_validate({**TUITION, "provenance": "observed"})


def test_one_time_obligation_requires_mandatory_status():
    data = {key: value for key, value in TUITION.items() if key != "mandatory"}
    with pytest.raises(ValidationError):
        OneTimeObligation.model_validate(data)


@pytest.mark.parametrize("amount", [0, -1])
def test_one_time_obligation_amount_must_be_positive(amount):
    with pytest.raises(ValidationError):
        OneTimeObligation.model_validate({**TUITION, "amount": amount})


@pytest.mark.parametrize("due_date", ["next January", "2027-13-01", ""])
def test_one_time_obligation_rejects_a_malformed_due_date(due_date):
    with pytest.raises(ValidationError):
        OneTimeObligation.model_validate({**TUITION, "due_date": due_date})


def test_twin_without_one_time_obligations_still_validates():
    """The backwards-compatibility assertion the other two workstreams rely on."""
    data = load_twin().model_dump(mode="json")
    del data["one_time_obligations"]
    assert FinancialTwin.model_validate(data).one_time_obligations == []


def test_twin_keeps_one_time_obligations_in_order():
    second = {**TUITION, "id": "one_deposit", "name": "Deposit", "due_date": "2026-11-01"}
    declared = [OneTimeObligation.model_validate(o) for o in (TUITION, second)]
    twin = load_twin().model_copy(update={"one_time_obligations": declared})
    parsed = FinancialTwin.model_validate_json(twin.model_dump_json())
    assert [o.id for o in parsed.one_time_obligations] == ["one_tuition", "one_deposit"]


# --- Processing lineage -------------------------------------------------------

RUN_ID = "0123456789abcdef0123456789abcdef"  # MLflow's shape: 32 lowercase hex.

LINEAGE = {
    "location": "databricks",
    "status": "succeeded",
    "mlflow_run_id": RUN_ID,
    "run_time": "2026-09-19T04:15:00Z",
}


def test_twin_lineage_is_optional_and_unset_on_the_fixture():
    """Nothing records lineage yet, so the UI must show it as unavailable."""
    twin = load_twin()
    assert twin.lineage is None
    carried = twin.model_copy(update={"lineage": ProcessingLineage.model_validate(LINEAGE)})
    assert FinancialTwin.model_validate_json(carried.model_dump_json()) == carried


def test_lineage_needs_only_a_location():
    """A producer that knows where it ran and nothing else can still be honest."""
    lineage = ProcessingLineage(location="local")
    assert (lineage.status, lineage.mlflow_run_id, lineage.run_time) == ("unknown", None, None)


@pytest.mark.parametrize("location", ["local", "databricks"])
def test_lineage_accepts_every_known_location(location):
    assert ProcessingLineage.model_validate({**LINEAGE, "location": location}).location == location


@pytest.mark.parametrize(
    "bad",
    [{"location": "my_laptop"}, {"status": "probably_fine"}, {"run_time": "last Tuesday"}],
)
def test_lineage_rejects_values_outside_its_closed_sets(bad):
    with pytest.raises(ValidationError):
        ProcessingLineage.model_validate({**LINEAGE, **bad})


# Nothing here is real. These stand for the shapes a credential arrives in --
# a bearer token, a connection string, an environment dump -- to prove each is
# rejected by the schema rather than by a reviewer noticing it.
CREDENTIAL_SHAPED = [
    "Bearer abcdefghijklmnopqrstuvwxyz012345",
    "https://workspace.example?token=abcdef",
    "DATABRICKS_TOKEN=abcdef123456",
    "0123456789ABCDEF0123456789ABCDEF",  # right length, wrong alphabet
    RUN_ID + "extra",
]


@pytest.mark.parametrize("value", CREDENTIAL_SHAPED)
@pytest.mark.parametrize("field", ["location", "status", "mlflow_run_id", "run_time"])
def test_no_field_of_lineage_can_hold_a_credential(field, value):
    """frontend/SPEC.md section 3.5: no secret can reach the browser.

    Every field is a closed set of words, a fixed identifier shape or a
    timestamp, so there is nowhere a token could be pasted in even by mistake.
    """
    with pytest.raises(ValidationError):
        ProcessingLineage.model_validate({**LINEAGE, field: value})


@pytest.mark.parametrize("name", ["token", "api_key", "password", "host", "connection_string"])
def test_lineage_rejects_a_secret_smuggled_in_under_a_new_name(name):
    """A field added without review must fail loudly, not serialize to the browser."""
    with pytest.raises(ValidationError):
        ProcessingLineage.model_validate({**LINEAGE, name: "secret-value"})


def test_a_twin_carrying_lineage_serializes_nothing_but_identifiers():
    twin = load_twin().model_copy(
        update={"lineage": ProcessingLineage.model_validate(LINEAGE)}
    )
    payload = twin.model_dump(mode="json")["lineage"]
    assert set(payload) == {"location", "status", "mlflow_run_id", "run_time"}


# --- Contracts for the minimalist layout (frontend/SPEC.md section 4) ---------


def test_obligation_without_active_defaults_true():
    """4.1: a twin saved before `active` existed still validates, and is not paused."""
    obligation = FinancialObligation.model_validate(
        {
            "id": "obl_rent",
            "name": "Rent",
            "expected_amount": 650.0,
            "due_day": 1,
            "confidence": 0.99,
        }
    )
    assert obligation.active is True


def test_every_obligation_on_the_fixture_twin_is_active():
    assert all(obligation.active for obligation in load_twin().obligations)


@pytest.mark.parametrize("amount", [float("nan"), float("inf"), float("-inf"), 1_000_000_001])
def test_new_money_fields_reject_nan_infinity_and_over_a_billion(amount):
    """API-4. Applied to the models this section adds, not to the older contracts."""
    with pytest.raises(ValidationError):
        ReserveRequest(amount=amount)


@pytest.mark.parametrize("amount", [0, -1])
def test_a_positive_money_field_rejects_zero_and_negatives(amount):
    with pytest.raises(ValidationError):
        SimulatePrefill(description="Laptop", amount=amount)


def test_a_name_is_trimmed_and_its_inner_whitespace_collapsed():
    """API-5, so a length check cannot be passed with padding."""
    assert GoalChanges(name="  Spring   break \n").name == "Spring break"


@pytest.mark.parametrize("name", ["", "   ", "x" * 81])
def test_a_blank_or_over_long_name_is_rejected(name):
    with pytest.raises(ValidationError):
        RecurringObligationCreate(name=name, amount=10, due_day=1)


@pytest.mark.parametrize(
    "model", [GoalChanges, RecurringObligationChanges, OneTimeObligationChanges]
)
def test_a_changes_body_with_no_field_is_rejected(model):
    """Section 6: a PUT or PATCH that changes nothing is a 422, not a no-op write."""
    with pytest.raises(ValidationError):
        model()


def test_a_changes_body_accepts_an_explicit_null_it_was_given():
    """`model_fields_set`, not None, decides: an omitted field differs from a sent one."""
    assert RecurringObligationChanges(active=False).active is False


def test_overview_holds_at_most_four_categories_plus_other():
    slices = [SpendingSlice(label=str(i), monthly_amount=1) for i in range(6)]
    with pytest.raises(ValidationError):
        OverviewPayload(
            user_id="alex",
            as_of=date(2026, 9, 18),
            total_balance=1,
            monthly_net_cash_flow=1,
            accounts=[],
            spending=slices,
            total_monthly_spending=1,
        )


def test_upcoming_items_must_be_ascending_by_date():
    """OV-7. The page slices this list; it does not sort it (G-6)."""
    items = [
        UpcomingItem(name="Rent", amount=-650, date=date(2026, 10, 1), kind="recurring_bill"),
        UpcomingItem(name="Pay", amount=900, date=date(2026, 9, 25), kind="income"),
    ]
    with pytest.raises(ValidationError):
        OverviewPayload(
            user_id="alex",
            as_of=date(2026, 9, 18),
            total_balance=1,
            monthly_net_cash_flow=1,
            accounts=[],
            total_monthly_spending=1,
            upcoming=items,
        )


def test_a_forecast_carries_at_most_four_callouts():
    callout = {"date": "2026-10-01", "kind": "peak", "balance": 100.0, "label": "High point"}
    bands = {"total": [], "checking": []}
    with pytest.raises(ValidationError):
        ForecastPayload(
            user_id="alex",
            horizon_end=date(2027, 6, 1),
            bands=bands,
            callouts=[callout] * 5,
        )


@pytest.mark.parametrize("count", [0, 2])
def test_a_commit_carries_exactly_one_purchase(count):
    """CM-3: one purchase in v1, so a client cannot smuggle a second one in."""
    event = {
        "type": "purchase",
        "description": "Laptop",
        "amount": 800.0,
        "date": "2026-09-20",
        "account_id": "acc_checking",
    }
    with pytest.raises(ValidationError):
        CommitPurchaseRequest(events=[event] * count)


# One well-formed proposal of each action type, as the message response carries them.
PROPOSALS = {
    "ADD_GOAL": {
        "action_type": "ADD_GOAL",
        "proposal_id": "prop_1",
        "source_fragment": "save $2,000 for a trip",
        "goal": {
            "id": "goal_trip",
            "name": "Trip",
            "target_amount": 2000.0,
            "deadline": "2027-06-01",
        },
    },
    "UPDATE_GOAL": {
        "action_type": "UPDATE_GOAL",
        "proposal_id": "prop_2",
        "source_fragment": "to $2,500",
        "goal_id": "goal_summer_housing",
        "goal_name": "Summer housing",
        "changes": {"target_amount": 2500.0},
    },
    "ADD_OBLIGATION": {
        "action_type": "ADD_OBLIGATION",
        "proposal_id": "prop_3",
        "source_fragment": "$1,200 tuition due Jan 15",
        "obligation": {
            "id": "one_tuition",
            "name": "Tuition",
            "amount": 1200.0,
            "due_date": "2027-01-15",
            "account_id": "acc_checking",
            "mandatory": True,
        },
    },
    "UPDATE_OBLIGATION": {
        "action_type": "UPDATE_OBLIGATION",
        "proposal_id": "prop_4",
        "source_fragment": "rent went up to 1050",
        "obligation_id": "obl_rent",
        "obligation_name": "Rent",
        "kind": "recurring",
        "recurring_changes": {"amount": 1050.0},
    },
    "SET_CONSTRAINT": {
        "action_type": "SET_CONSTRAINT",
        "proposal_id": "prop_5",
        "source_fragment": "keep at least $1,500",
        "constraint": {
            "id": "con_reserve",
            "type": "minimum_reserve",
            "amount": 1500.0,
            "description": "Emergency reserve",
        },
    },
    "CLASSIFY_OBLIGATION": {
        "action_type": "CLASSIFY_OBLIGATION",
        "proposal_id": "prop_6",
        "source_fragment": "the $50 transfer is savings",
        "classification": {
            "obligation_id": "obl_online_transfer_to",
            "obligation_name": "Online Transfer To",
            "category": "savings_transfer",
            "fragment": "the $50 transfer is savings",
        },
    },
}


def message_response(**overrides):
    payload = {
        "conversation_id": "conv_1",
        "message_id": "msg_1",
        "reply": "Here is what I understood. Nothing changes until you accept.",
        "read_by": "rules",
    }
    return AssistantMessageResponse.model_validate({**payload, **overrides})


@pytest.mark.parametrize("action_type", sorted(PROPOSALS))
def test_a_proposal_is_read_back_as_its_own_action_type(action_type):
    """4.7: the union is discriminated, so a card is never parsed as the wrong action."""
    response = message_response(proposals=[PROPOSALS[action_type]])
    proposal = response.proposals[0]
    assert proposal.action_type == action_type
    assert proposal.status == "pending"
    assert proposal.requires_user_confirmation is True


def test_every_proposal_survives_a_round_trip_through_json():
    # Five at a time: a response carries at most five proposals (AS-17).
    drafts = list(PROPOSALS.values())
    for batch in (drafts[:5], drafts[5:]):
        response = message_response(proposals=batch)
        again = AssistantMessageResponse.model_validate(response.model_dump(mode="json"))
        assert [p.action_type for p in again.proposals] == [d["action_type"] for d in batch]


def test_a_proposal_must_quote_the_user():
    """V1: the card shows the user's own words, so an empty quote is not a proposal."""
    with pytest.raises(ValidationError):
        message_response(proposals=[{**PROPOSALS["ADD_GOAL"], "source_fragment": ""}])


def test_an_unknown_action_type_is_rejected():
    with pytest.raises(ValidationError):
        message_response(proposals=[{**PROPOSALS["ADD_GOAL"], "action_type": "DELETE_TWIN"}])


def test_an_obligation_update_carries_the_changes_for_its_own_kind():
    wrong_kind = {**PROPOSALS["UPDATE_OBLIGATION"], "kind": "one_time"}
    with pytest.raises(ValidationError):
        message_response(proposals=[wrong_kind])


def test_an_obligation_update_may_not_carry_both_kinds_of_change():
    both = {**PROPOSALS["UPDATE_OBLIGATION"], "one_time_changes": {"amount": 10.0}}
    with pytest.raises(ValidationError):
        message_response(proposals=[both])


def test_a_response_carries_at_most_five_proposals():
    """AS-17. A sixth is dropped by the Assistant before it gets here."""
    six = [{**PROPOSALS["ADD_GOAL"], "proposal_id": f"prop_{i}"} for i in range(6)]
    with pytest.raises(ValidationError):
        message_response(proposals=six)


QUESTION = {
    "question_id": "q_1",
    "text": "When do you need it by? Please give a date.",
    "field": "deadline",
    "fragment": "next summer",
}


def test_a_response_carries_at_most_three_questions():
    with pytest.raises(ValidationError):
        message_response(questions=[QUESTION] * 4)


def test_the_opening_asks_at_most_two_questions():
    """AS-9: the chat opens with a couple of questions, not an interrogation."""
    AssistantOpening(questions=[QUESTION] * 2)
    with pytest.raises(ValidationError):
        AssistantOpening(questions=[QUESTION] * 3)


@pytest.mark.parametrize("field", ["which_one", "category", "amount", "intent"])
def test_a_question_may_be_about_a_target_or_a_missing_detail(field):
    assert AssistantQuestion(**{**QUESTION, "field": field}).field == field


@pytest.mark.parametrize("text", ["", " " * 0, "x" * 2001])
def test_a_message_is_between_one_and_two_thousand_characters(text):
    """AS-10 and the 2,001-character row of the acceptance corpus."""
    with pytest.raises(ValidationError):
        AssistantMessageRequest(user_id="alex", text=text)


def test_a_two_thousand_character_message_is_accepted():
    assert len(AssistantMessageRequest(user_id="alex", text="x" * 2000).text) == 2000


def test_a_rejected_proposal_returns_no_twin():
    decision = ProposalDecisionResponse(proposal_id="prop_1", status="rejected")
    assert decision.twin is None


# --- The TypeScript mirror ----------------------------------------------------

TYPES_TS = Path(__file__).resolve().parents[2] / "frontend" / "lib" / "types.ts"

# Every model this section adds, plus the one existing model it changes. Each must
# appear in types.ts with all of its fields (CLAUDE.md, Shared Contracts).
MIRRORED_MODELS = [
    FinancialObligation,
    OverviewAccount,
    SpendingSlice,
    UpcomingItem,
    OverviewPayload,
    CategoryOption,
    RecurringObligationRow,
    OneTimeObligationRow,
    ObligationsPayload,
    RecurringObligationCreate,
    RecurringObligationChanges,
    OneTimeObligationCreate,
    OneTimeObligationChanges,
    GoalChanges,
    ReserveRequest,
    ForecastCallout,
    ForecastPayload,
    GoalDateChange,
    CommitPurchaseRequest,
    CommitPurchaseResponse,
    EarliestDateRequest,
    EarliestDateResponse,
    ProposalBase,
    AddGoalProposal,
    UpdateGoalProposal,
    AddObligationProposal,
    UpdateObligationProposal,
    SetConstraintProposal,
    ClassifyObligationProposal,
    AssistantQuestion,
    SimulatePrefill,
    AssistantMessageRequest,
    AssistantMessageResponse,
    AssistantOpening,
    ProposalDecisionRequest,
    ProposalDecisionResponse,
]


def ts_interface_body(name: str) -> str:
    """The text between `export interface <name> {` and its closing brace."""
    source = TYPES_TS.read_text()
    match = re.search(rf"^export interface {name}(?: extends \w+)? \{{$", source, re.MULTILINE)
    assert match, f"{name} is missing from frontend/lib/types.ts"
    end = source.index("\n}\n", match.end())
    return source[match.end() : end]


@pytest.mark.parametrize("model", MIRRORED_MODELS, ids=lambda m: m.__name__)
def test_every_field_is_mirrored_in_types_ts(model):
    """Catches the usual drift: a field added on one side of the contract only.

    A text scan, not a type check -- it proves the name is there, not that the
    TypeScript type matches. Reviewing the shape is still a human job.
    """
    inherited = set()
    for parent in model.__mro__[1:]:
        inherited |= set(getattr(parent, "model_fields", {}))
    body = ts_interface_body(model.__name__)
    for field in model.model_fields:
        if field in inherited:
            continue
        assert re.search(rf"^  {field}\??:", body, re.MULTILINE), (
            f"{model.__name__}.{field} is missing from frontend/lib/types.ts"
        )


@pytest.mark.parametrize("alias", ["AssistantAction", "Proposal"])
def test_the_union_aliases_are_mirrored_too(alias):
    assert re.search(rf"^export type {alias} =", TYPES_TS.read_text(), re.MULTILINE)
