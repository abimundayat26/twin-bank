"""Goal compiler: text to draft goals and constraints, and the /goals/compile + PUT /twin/{user_id}/goals API."""

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from backend.fixtures import load_twin
from backend.goal_compiler import (
    check_deadline,
    compile_goals,
    dedupe_constraints,
    split_clauses,
    unique_goal_id,
)
from backend.main import app
from backend.schemas import (
    Account,
    FinancialConstraint,
    FinancialTwin,
    GoalCompileResponse,
    SimulationResponse,
)
from backend.simulation.engine import MAX_HORIZON_DAYS

client = TestClient(app)
AS_OF = date(2026, 9, 19)
ALEX = "I need $1,600 for summer housing by May and want to keep at least $1,500 for emergencies"


def compile_text(text: str, as_of: date = AS_OF) -> GoalCompileResponse:
    return compile_goals("alex", text, as_of)


def fields(result: GoalCompileResponse) -> list[str]:
    return [c.field for c in result.clarifications]



# --- One-time obligations ------------------------------------------------------

TUITION = "I have $1,200 tuition due 2027-01-15 from checking, mandatory"


def compile_obligation(text: str, accounts=None, as_of: date = AS_OF) -> GoalCompileResponse:
    """Alex's two accounts unless a test needs a different set."""
    return compile_goals("alex", text, as_of, load_twin().accounts if accounts is None else accounts)


def test_a_declared_obligation_compiles_with_nothing_left_to_ask():
    result = compile_obligation(TUITION)
    [obligation] = result.one_time_obligations
    assert (obligation.name, obligation.amount) == ("Tuition", 1200.0)
    assert obligation.due_date == date(2027, 1, 15)
    assert obligation.account_id == "acc_checking"
    assert obligation.mandatory is True
    assert obligation.provenance == "declared"
    assert result.goals == [] and result.clarifications == [] and result.unparsed == []


def test_an_obligation_without_an_amount_asks_and_drafts_nothing():
    result = compile_obligation("I have tuition due 2027-01-15 from checking, mandatory")
    assert result.one_time_obligations == []
    assert fields(result) == ["amount"]
    assert result.clarifications[0].fragment == (
        "I have tuition due 2027-01-15 from checking, mandatory"
    )


def test_an_obligation_without_a_due_date_asks_and_drafts_nothing():
    result = compile_obligation("I have $1,200 tuition from checking, mandatory")
    assert result.one_time_obligations == []
    assert fields(result) == ["deadline"]


def test_an_obligation_without_a_name_asks_and_drafts_nothing():
    result = compile_obligation("I owe $1,200 by 2027-01-15 from checking, mandatory")
    assert result.one_time_obligations == []
    assert fields(result) == ["name"]


def test_an_obligation_with_no_funding_account_named_asks_which_one():
    result = compile_obligation("I have $1,200 tuition due 2027-01-15, mandatory")
    assert result.one_time_obligations == []
    assert fields(result) == ["account"]
    assert "Everyday Checking" in result.clarifications[0].question


def test_one_account_on_file_is_still_not_an_answer_the_user_declared():
    only = [Account(id="acc_only", name="Everyday Checking", type="checking", balance=500)]
    result = compile_obligation("I have $1,200 tuition due 2027-01-15, mandatory", only)
    assert result.one_time_obligations == []
    assert fields(result) == ["account"]


def test_an_obligation_without_mandatory_status_asks_and_drafts_nothing():
    result = compile_obligation("I have $1,200 tuition due 2027-01-15 from checking")
    assert result.one_time_obligations == []
    assert fields(result) == ["mandatory"]


def test_an_optional_obligation_keeps_the_status_the_user_stated():
    result = compile_obligation(
        "I have $1,200 tuition due 2027-01-15 from checking, optional"
    )
    [obligation] = result.one_time_obligations
    assert obligation.mandatory is False


def test_a_savings_goal_is_still_a_goal_not_an_obligation():
    """The regression that matters most: obligation words must not steal goals."""
    result = compile_obligation("save $2,000 for a trip by 2027-06-01")
    assert result.one_time_obligations == []
    assert [(g.name, g.deadline) for g in result.goals] == [("Trip", date(2027, 6, 1))]


def test_a_clause_that_reads_as_either_asks_which_it_is():
    result = compile_obligation("I need to pay $400")
    assert result.one_time_obligations == [] and result.goals == []
    assert fields(result) == ["intent"]


def test_an_obligation_already_past_is_asked_about_not_back_dated():
    result = compile_obligation(
        "I have $1,200 tuition due 2020-01-15 from checking, mandatory"
    )
    assert result.one_time_obligations == []
    assert fields(result) == ["deadline"]
    assert "already passed" in result.clarifications[0].question


def test_two_obligations_in_one_sentence_split():
    result = compile_obligation(
        "I have $1,200 tuition due 2027-01-15 from checking, mandatory "
        "and $400 car insurance due 2026-11-01 from checking, optional"
    )
    assert [(o.id, o.name, o.amount) for o in result.one_time_obligations] == [
        ("one_tuition", "Tuition", 1200.0),
        ("one_car_insurance", "Car insurance", 400.0),
    ]
    assert result.clarifications == []


# --- compiler -----------------------------------------------------------------


def test_alex_sentence_compiles_to_the_fixture_goal_and_reserve():
    twin = load_twin()
    result = compile_text(ALEX)
    assert result.goals == twin.goals
    assert result.constraints == twin.constraints
    assert result.clarifications == [] and result.unparsed == []
    assert result.compiler == "rules"


def test_goal_without_amount_or_deadline_asks_instead_of_guessing():
    result = compile_text("I want to save for a car")
    assert result.goals == []
    assert fields(result) == ["amount", "deadline"]
    assert "for a car" in result.clarifications[0].question


def test_goal_without_a_name_asks_what_it_is_for():
    result = compile_text("I need $1,000 by May")
    assert result.goals == []
    assert fields(result) == ["name"]


def test_vague_deadline_is_asked_about_not_resolved():
    result = compile_text("I want $2000 for housing by summer")
    assert result.goals == []
    assert fields(result) == ["deadline"]
    assert "by summer" in result.clarifications[0].question


@pytest.mark.parametrize(
    ("phrase", "expected"),
    [
        ("by May", date(2027, 5, 1)),  # already past this year's May: next May
        ("by October", date(2026, 10, 1)),
        ("by September", date(2027, 9, 1)),  # this year's September 1 has passed
        ("by May 15th", date(2027, 5, 15)),
        ("by the 1st of Oct", date(2026, 10, 1)),
        ("by the end of Feb", date(2027, 2, 28)),
        ("by Dec 12, 2027", date(2027, 12, 12)),
        ("by May 2028", date(2028, 5, 1)),
        ("by 2027-03-15", date(2027, 3, 15)),
        ("by next June", date(2027, 6, 1)),  # same as "by June": the qualifier adds nothing
        ("by next March", date(2027, 3, 1)),
        ("by this December", date(2026, 12, 1)),  # "this" must not push it a year out
        ("by next month", date(2026, 10, 1)),
        ("by this month", date(2026, 9, 30)),
        ("by the end of next June", date(2027, 6, 30)),
        ("by the 15th of next June", date(2027, 6, 15)),
        ("in 6 months", date(2027, 3, 19)),
        ("in 3 weeks", date(2026, 10, 10)),
        ("within a year", date(2027, 9, 19)),
    ],
)
def test_deadlines(phrase, expected):
    [goal] = compile_text(f"I need $500 for a trip {phrase}").goals
    assert goal.deadline == expected


def test_a_month_qualifier_does_not_change_the_date():
    [plain] = compile_text("I need $500 for a trip by June").goals
    [qualified] = compile_text("I need $500 for a trip by next June").goals
    assert plain.deadline == qualified.deadline == date(2027, 6, 1)


def test_next_summer_is_still_vague_rather_than_a_silent_date():
    result = compile_text("I want $2000 for housing by next summer")
    assert result.goals == []
    assert fields(result) == ["deadline"]
    assert "by next summer" in result.clarifications[0].question


def test_a_qualifier_in_front_of_a_non_month_is_still_no_date():
    result = compile_text("I want $2000 for housing by next Foo")
    assert result.goals == []
    assert fields(result) == ["deadline"]
    assert result.clarifications[0].question == "When do you need the money for housing?"


def test_past_deadline_is_asked_about():
    result = compile_text("I need $900 for a deposit by 2025-01-01")
    assert result.goals == []
    assert fields(result) == ["deadline"]
    assert "already passed" in result.clarifications[0].question


def test_impossible_date_is_asked_about():
    result = compile_text("I need $900 for a deposit by Feb 30")
    assert fields(result) == ["deadline"]


@pytest.mark.parametrize("phrase", ["in 99999 years", "in 999999999 weeks", "by May 0000"])
def test_out_of_range_date_is_asked_about_not_a_crash(phrase):
    result = compile_text(f"Save $500 for a trip {phrase}")
    assert result.goals == []
    assert fields(result) == ["deadline"]


def test_deadline_past_the_longest_horizon_is_asked_about():
    result = compile_text("Save $5,000 for a car in 3 years")
    assert result.goals == []
    assert fields(result) == ["deadline"]
    assert "2028-09-18" in result.clarifications[0].question


def test_month_abbreviation_with_a_period_keeps_its_day():
    result = compile_text("I need $500 for books by Jan. 15. Keep at least $1,000 for emergencies.")
    assert [(g.name, g.deadline) for g in result.goals] == [("Books", date(2027, 1, 15))]
    assert [c.type for c in result.constraints] == ["minimum_reserve"]
    assert result.unparsed == []


@pytest.mark.parametrize(
    "text",
    [
        "Save $3,000 for an emergency fund by December",
        "I want to reserve $200 for concert tickets by October 30",
        "Save $3,000 for an emergency fund",
    ],
)
def test_reserve_words_with_a_deadline_or_no_keep_ask_which_kind(text):
    result = compile_text(text)
    assert result.goals == [] and result.constraints == []
    assert fields(result) == ["type"]


@pytest.mark.parametrize(
    ("text", "amount"),
    [("$2,000.50 for rent", 2000.5), ("3k for rent", 3000), ("$1.5k for rent", 1500), ("400 dollars for rent", 400)],
)
def test_amounts(text, amount):
    [goal] = compile_text(f"I need {text} by May").goals
    assert goal.target_amount == amount


def test_several_goals_and_a_checking_minimum():
    result = compile_text(
        "I need $500 for books and supplies by January; $1,200 for a bike in 6 months. "
        "Keep at least $300 in checking."
    )
    assert [(g.id, g.name, g.target_amount) for g in result.goals] == [
        ("goal_books_and_supplies", "Books and supplies", 500),
        ("goal_bike", "Bike", 1200),
    ]
    [floor] = result.constraints
    assert (floor.type, floor.amount, floor.id) == ("minimum_checking_balance", 300, "con_minimum_checking")


def test_and_inside_a_goal_name_does_not_split_it():
    assert split_clauses("$500 for books and supplies by January") == [
        "$500 for books and supplies by January"
    ]


@pytest.mark.parametrize(
    "text",
    [
        "keep $1,500 for emergencies and $300 in checking",
        "Keep at least $1,500 for emergencies. $300 in checking.",
    ],
)
def test_amount_after_a_keep_carries_the_keep(text):
    result = compile_text(text)
    assert [(c.type, c.amount) for c in result.constraints] == [
        ("minimum_reserve", 1500),
        ("minimum_checking_balance", 300),
    ]
    assert result.clarifications == [] and result.unparsed == []


def test_reserve_amount_after_a_checking_keep_carries_the_keep():
    result = compile_text("keep at least $300 in checking and $1,500 for emergencies")
    assert [(c.type, c.amount) for c in result.constraints] == [
        ("minimum_checking_balance", 300),
        ("minimum_reserve", 1500),
    ]
    assert result.clarifications == [] and result.unparsed == []


def test_carried_keep_with_a_deadline_still_asks_which_kind():
    result = compile_text("keep $300 in checking and $1,500 for emergencies by May")
    assert [c.type for c in result.constraints] == ["minimum_checking_balance"]
    assert fields(result) == ["type"]


def test_checking_balance_statement_is_not_a_minimum():
    result = compile_text("Keep at least $1,500 for emergencies. I have $300 in checking.")
    assert [c.type for c in result.constraints] == ["minimum_reserve"]
    assert result.unparsed == ["I have $300 in checking"]


def test_ambiguous_minimum_asks_which_kind():
    result = compile_text("keep at least $1,500")
    assert result.constraints == []
    assert fields(result) == ["type"]


def test_two_amounts_in_one_clause_asks_which():
    result = compile_text("I need $2,000 or $2,500 for housing by May")
    assert result.goals == []
    assert fields(result) == ["amount"]


def test_two_reserves_asks_which():
    result = compile_text("Keep $1,500 for emergencies. Keep $2,000 for emergencies.")
    assert result.constraints == []
    assert fields(result) == ["amount"]


def test_same_goal_name_twice_gets_distinct_ids():
    result = compile_text("I need $100 for a trip by May and $200 for a trip by June")
    assert [g.id for g in result.goals] == ["goal_trip", "goal_trip_2"]


def test_text_without_goals_is_unparsed_and_nothing_is_invented():
    result = compile_text("hello there, the weather is nice. I have $500")
    assert result.goals == [] and result.constraints == [] and result.clarifications == []
    assert result.unparsed == ["hello there, the weather is nice", "I have $500"]


def test_everything_is_declared():
    result = compile_text(ALEX)
    assert all(g.provenance == "declared" for g in result.goals)
    assert all(c.provenance == "declared" for c in result.constraints)


# --- API ----------------------------------------------------------------------


def compile_api(text: str, user_id: str = "alex"):
    return client.post("/goals/compile", json={"user_id": user_id, "text": text})


def get_twin() -> FinancialTwin:
    return FinancialTwin.model_validate(client.get("/twin/alex").json())


def test_compile_endpoint_returns_drafts_and_saves_nothing():
    response = compile_api("I need $3,000 for a car by March")
    assert response.status_code == 200
    result = GoalCompileResponse.model_validate(response.json())
    assert [g.name for g in result.goals] == ["Car"]
    assert get_twin().goals == load_twin().goals


def test_compile_endpoint_resolves_a_relative_month_without_clarifying():
    response = compile_api("I want to save $2,000 for a trip by next June")
    assert response.status_code == 200
    result = GoalCompileResponse.model_validate(response.json())
    assert [(goal.name, goal.target_amount, goal.deadline) for goal in result.goals] == [
        ("Trip", 2000.0, date(2027, 6, 1))
    ]
    assert result.clarifications == []
    assert result.compiler == "rules"


def test_compile_endpoint_survives_an_out_of_range_date():
    response = compile_api("Save $500 for a trip in 99999 years")
    assert response.status_code == 200
    assert response.json()["clarifications"][0]["field"] == "deadline"


def test_compile_endpoint_drafts_an_obligation_against_the_twins_own_accounts():
    """The endpoint, not just the function: acc_checking can only come from the twin."""
    response = compile_api(TUITION)
    assert response.status_code == 200
    result = GoalCompileResponse.model_validate(response.json())
    assert [(o.name, o.amount, o.account_id) for o in result.one_time_obligations] == [
        ("Tuition", 1200.0, "acc_checking")
    ]
    assert result.compiler == "rules"
    assert result.clarifications == []
    # Drafts only. Nothing is saved until the user confirms.
    assert get_twin().one_time_obligations == []


def test_compile_endpoint_rejects_unknown_user_and_empty_text():
    assert compile_api(ALEX, user_id="bob").status_code == 404
    assert compile_api("").status_code == 422


def test_confirmed_goals_replace_the_twin_goals_and_drive_the_horizon():
    drafts = compile_api("I need $3,000 for a car by March and keep at least $1,000 for emergencies").json()
    response = client.put(
        "/twin/alex/goals", json={"goals": drafts["goals"], "constraints": drafts["constraints"]}
    )
    assert response.status_code == 200
    twin = get_twin()
    assert [(g.name, g.deadline) for g in twin.goals] == [("Car", date(2027, 3, 1))]
    assert [(c.type, c.amount) for c in twin.constraints] == [("minimum_reserve", 1000)]

    laptop = {
        "type": "purchase",
        "description": "Laptop",
        "amount": 800,
        "date": "2026-09-20",
        "account_id": "acc_checking",
    }
    simulation = client.post("/simulate", json={"user_id": "alex", "events": [laptop]})
    assert simulation.status_code == 200
    assert SimulationResponse.model_validate(simulation.json()).horizon_end == date(2027, 3, 1)


def test_goals_put_keeps_the_checking_minimum_unless_given_one():
    client.put("/twin/alex/minimum-balance", json={"amount": 250})
    client.put("/twin/alex/goals", json={"goals": []})
    twin = get_twin()
    assert twin.goals == []
    assert [(c.type, c.amount) for c in twin.constraints] == [("minimum_checking_balance", 250)]

    floor = {"id": "con_minimum_checking", "type": "minimum_checking_balance", "amount": 400, "description": "x"}
    client.put("/twin/alex/goals", json={"goals": [], "constraints": [floor]})
    assert [c.amount for c in get_twin().constraints] == [400]


@pytest.mark.parametrize(
    "goals",
    [
        # Not after the twin's as_of, so there is no future left to save in.
        [{"id": "g", "name": "Past", "target_amount": 100, "deadline": "2026-09-18"}],
        [{"id": "g", "name": "Far", "target_amount": 100, "deadline": "2030-01-01"}],
        [
            {"id": "g", "name": "A", "target_amount": 100, "deadline": "2027-01-01"},
            {"id": "g", "name": "B", "target_amount": 100, "deadline": "2027-02-01"},
        ],
    ],
)
def test_goals_put_rejects_bad_goals_and_changes_nothing(goals):
    assert client.put("/twin/alex/goals", json={"goals": goals}).status_code == 422
    assert get_twin() == load_twin().model_copy(update={"source": "fixture"})


def test_goals_put_rejects_two_reserves_and_unknown_user():
    reserve = {"id": "r", "type": "minimum_reserve", "amount": 100, "description": "x"}
    body = {"goals": [], "constraints": [reserve, {**reserve, "id": "r2"}]}
    assert client.put("/twin/alex/goals", json=body).status_code == 422
    assert client.put("/twin/bob/goals", json={"goals": []}).status_code == 404


# --- helpers shared with the LLM compiler -------------------------------------


def test_check_deadline_accepts_a_date_inside_the_horizon():
    assert check_deadline(date(2027, 5, 1), "by May", "for a car", AS_OF) is None


def test_check_deadline_asks_about_missing_vague_passed_and_too_far_dates():
    what = "for a car"
    assert check_deadline(None, None, what, AS_OF) == "When do you need the money for a car?"
    assert check_deadline(None, "by summer", what, AS_OF) == 'When exactly is "by summer"? Give a date.'
    assert "already passed" in check_deadline(AS_OF, "by 2026-09-19", what, AS_OF)
    latest = AS_OF + timedelta(days=MAX_HORIZON_DAYS)
    assert check_deadline(latest, None, what, AS_OF) is None
    assert "too far ahead" in check_deadline(latest + timedelta(days=1), None, what, AS_OF)


def test_unique_goal_id_adds_a_suffix_only_when_taken():
    assert unique_goal_id("Summer housing", set()) == "goal_summer_housing"
    assert unique_goal_id("Car", {"goal_car"}) == "goal_car_2"
    assert unique_goal_id("Car", {"goal_car", "goal_car_2"}) == "goal_car_3"


def test_dedupe_constraints_drops_a_repeated_type_and_asks_which_amount():
    reserve = FinancialConstraint(id="a", type="minimum_reserve", amount=1500, description="")
    other_reserve = reserve.model_copy(update={"amount": 1000})
    floor = FinancialConstraint(id="b", type="minimum_checking_balance", amount=300, description="")
    asked = []

    kept = dedupe_constraints([reserve, floor, other_reserve], "text", lambda *a: asked.append(a))

    assert kept == [floor]
    assert asked == [("amount", "You gave two amounts to keep ($1,500 and $1,000). Which one?", "text")]
