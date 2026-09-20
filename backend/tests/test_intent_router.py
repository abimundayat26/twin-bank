"""Intent routing: which kind of declaration a clause is, decided in code. No network."""

import pytest
from fastapi.testclient import TestClient

from backend.fixtures import load_twin
from backend.goal_compiler import compile_goals, split_clauses
from backend.intent_router import route_clause, route_clauses
from backend.main import app
from backend.schemas import FinancialTwin, GoalCompileResponse

client = TestClient(app)
AS_OF = load_twin().as_of


@pytest.fixture
def detected():
    return load_twin().obligations


def intent(clause: str, detected=()) -> str:
    return route_clause(clause, detected).intent


def obligation_id(detected, word: str) -> str:
    return next(obligation.id for obligation in detected if word in obligation.name.lower())


# --- one phrase per intent ------------------------------------------------------


def test_a_savings_target_is_a_goal(detected):
    assert intent("I want to save $2,000 for a trip by 2027-06-01", detected) == "goal"


def test_a_standing_limit_is_a_constraint(detected):
    assert intent("keep at least $300 in checking", detected) == "constraint"


def test_an_expense_already_owed_is_a_one_time_obligation(detected):
    assert intent(
        "I have $1,200 tuition due 2027-01-15 from checking, mandatory", detected
    ) == (
        "one_time_obligation"
    )


def test_an_answer_about_a_detected_payment_is_a_classification(detected):
    routed = route_clause("the recurring transfer is savings", detected)
    assert routed.intent == "obligation_classification"
    assert routed.obligation_id == obligation_id(detected, "transfer")
    assert routed.category == "savings_transfer"


def test_text_that_declares_nothing_is_nothing(detected):
    assert intent("the weather is nice today", detected) == "nothing"


# --- ambiguity is asked about, never resolved ------------------------------------


def test_a_clause_that_reads_two_ways_asks_and_names_both(detected):
    routed = route_clause("I need to pay $400", detected)
    assert routed.intent == "ambiguous"
    assert routed.question == (
        "Is this a goal you are saving toward, or an expense you already owe?"
    )
    assert routed.obligation_id is None and routed.category is None


def test_the_question_names_every_reading_it_found(detected):
    routed = route_clause("I want to keep at least $1,500 for emergencies", detected)
    assert routed.intent == "ambiguous"
    assert "a limit you want to keep at all times" in routed.question
    assert "a goal you are saving toward" in routed.question


@pytest.mark.parametrize("text", ["", "   ", "\n\t "])
def test_empty_input_declares_nothing(text, detected):
    assert route_clauses(split_clauses(text), detected) == []
    assert route_clause(text, detected).intent == "nothing"


# --- a classification can only ever name an obligation the twin has ---------------


def test_a_category_with_no_obligation_named_is_not_a_classification(detected):
    """"savings" alone names nothing to classify, so nothing is classified."""
    assert intent("that thing is savings", detected) == "nothing"


def test_a_category_word_inside_an_obligations_own_name_is_not_a_reference(detected):
    """A category word by itself names no detected obligation."""
    assert route_clause("that thing is savings", detected).obligation_id is None


def test_no_detected_obligations_means_no_classification():
    assert intent("the recurring transfer is savings", ()) == "nothing"


def test_a_routed_classification_always_names_a_real_obligation(detected):
    ids = {o.id for o in detected}
    clauses = [
        "the recurring transfer is savings",
        "the rent is a bill",
        "Spotify is optional",
        "that transfer is a loan repayment",
    ]
    for routed in route_clauses(clauses, detected):
        assert routed.intent == "obligation_classification"
        assert routed.obligation_id in ids


def test_a_word_that_is_both_the_category_and_an_obligation_word_is_counted_once(detected):
    """In "the rent is a bill", "bill" is the category. Reading it twice would invent
    an ambiguity between classifying a payment and declaring a new one."""
    routed = route_clause("the rent is a bill", detected)
    assert routed.intent == "obligation_classification"
    assert routed.obligation_id == obligation_id(detected, "rent")
    assert routed.category == "bill"


# --- through the compiler and the API --------------------------------------------


def test_the_compiler_reads_a_classification_back_instead_of_applying_it(detected):
    result = compile_goals("alex", "the recurring transfer is savings", AS_OF, (), detected)
    [draft] = result.classifications
    assert draft.obligation_id == obligation_id(detected, "transfer")
    assert draft.category == "savings_transfer"
    assert "Transfer" in draft.obligation_name
    assert draft.fragment == "the recurring transfer is savings"
    assert result.goals == [] and result.one_time_obligations == []


def test_one_message_can_carry_a_classification_and_a_goal(detected):
    result = compile_goals(
        "alex",
        "Spotify is optional and I want $500 for books by 2027-01-15",
        AS_OF,
        (),
        detected,
    )
    assert [c.obligation_id for c in result.classifications] == [
        obligation_id(detected, "spotify")
    ]
    assert [g.name for g in result.goals] == ["Books"]
    assert result.clarifications == []


def test_nothing_is_declared_without_a_confirmation():
    response = client.post(
        "/goals/compile", json={"user_id": "alex", "text": "the recurring transfer is savings"}
    )
    assert response.status_code == 200
    result = GoalCompileResponse.model_validate(response.json())
    assert [c.category for c in result.classifications] == ["savings_transfer"]
    assert result.compiler == "rules"
    twin = FinancialTwin.model_validate(client.get("/twin/alex").json())
    obligation = next(o for o in twin.obligations if "transfer" in o.name.lower())
    assert obligation.declared_category is None


def test_routing_never_needs_a_model(monkeypatch, detected):
    """no_real_llm has already stripped the env; this says the routing does not care."""
    monkeypatch.delenv("GOAL_COMPILER", raising=False)
    result = compile_goals("alex", "the rent is a bill", AS_OF, (), detected)
    assert result.compiler == "rules"
    assert [c.obligation_id for c in result.classifications] == [
        obligation_id(detected, "rent")
    ]


@pytest.mark.parametrize(("length", "status"), [(2000, 200), (2001, 422)])
def test_the_endpoint_bounds_how_much_it_will_route(length, status):
    response = client.post("/goals/compile", json={"user_id": "alex", "text": "a" * length})
    assert response.status_code == status
