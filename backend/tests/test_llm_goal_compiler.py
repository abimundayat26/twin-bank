"""LLM goal compiler: code-side checks on Claude's draft, and the fallback to rules. No network."""

from datetime import date

import anthropic
import httpx
import pytest
from fastapi.testclient import TestClient

from backend.fixtures import load_twin
from backend import llm_goal_compiler
from backend.llm_goal_compiler import LlmDraft, LlmItem, compile_goals_auto, validate_draft
from backend.main import app

AS_OF = date(2026, 9, 19)
ALEX = "I need $1,600 for summer housing by May and want to keep at least $1,500 for emergencies"


def item(
    kind="goal",
    fragment="",
    name=None,
    amount=None,
    deadline=None,
    question=None,
    question_field=None,
    mandatory=None,
):
    return LlmItem(
        kind=kind,
        fragment=fragment,
        name=name,
        amount=amount,
        deadline=deadline,
        question=question,
        question_field=question_field,
        mandatory=mandatory,
    )


def validate(text: str, *items: LlmItem, unparsed: list[str] | None = None, accounts=None):
    return validate_draft(
        "alex",
        text,
        AS_OF,
        LlmDraft(items=list(items), unparsed=unparsed or []),
        load_twin().accounts if accounts is None else accounts,
    )


@pytest.fixture
def llm_on(monkeypatch):
    monkeypatch.setenv("GOAL_COMPILER", "llm")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")


# --- validate_draft ---------------------------------------------------------------


def test_alex_draft_compiles_to_the_fixture_goal_and_reserve():
    twin = load_twin()
    result = validate(
        ALEX,
        item(fragment="I need $1,600 for summer housing by May", name="Summer housing", amount=1600,
             deadline="2027-05-01"),
        item(kind="reserve", fragment="keep at least $1,500 for emergencies", amount=1500),
    )
    assert result.goals == twin.goals
    assert result.constraints == twin.constraints
    assert result.clarifications == [] and result.unparsed == []
    assert result.compiler == "llm"


def test_amount_not_written_in_the_fragment_is_asked_about():
    result = validate(
        "I want to save for a car by May",
        item(fragment="save for a car by May", name="Car", amount=5000, deadline="2027-05-01"),
    )
    assert result.goals == []
    assert [c.field for c in result.clarifications] == ["amount"]


def test_fragment_not_in_the_text_is_dropped():
    result = validate(
        "I need $500 for books by January",
        item(fragment="I need $900 for a trip by March", name="Trip", amount=900, deadline="2027-03-01"),
    )
    assert result.goals == [] and result.clarifications == []


def test_rules_date_wins_over_the_llm_reading():
    result = validate(
        "I need $500 for books by January",
        item(fragment="I need $500 for books by January", name="Books", amount=500, deadline="2027-03-15"),
    )
    assert result.goals[0].deadline == date(2027, 1, 1)


def test_llm_date_is_used_when_the_rules_see_no_timing_words():
    result = validate(
        "I need $500 for books before my birthday on 3/15",
        item(fragment="I need $500 for books before my birthday on 3/15", name="Books", amount=500,
             deadline="2027-03-15"),
    )
    assert result.goals[0].deadline == date(2027, 3, 15)


@pytest.mark.parametrize("deadline", ["2026-01-01", "2030-01-01", "not a date", None])
def test_bad_or_missing_deadline_is_asked_about(deadline):
    result = validate(
        "I need $500 for books",
        item(fragment="I need $500 for books", name="Books", amount=500, deadline=deadline),
    )
    assert result.goals == []
    assert [c.field for c in result.clarifications] == ["deadline"]


TUITION = "I have $1,200 tuition due 2027-01-15 from checking, mandatory"


def test_obligation_item_is_drafted_against_a_real_account():
    result = validate(
        TUITION,
        item(
            kind="obligation",
            fragment=TUITION,
            name="Tuition",
            amount=1200,
            deadline="2027-01-15",
            mandatory=True,
        ),
    )
    assert [(o.name, o.amount, o.account_id) for o in result.one_time_obligations] == [
        ("Tuition", 1200.0, "acc_checking")
    ]
    assert result.goals == [] and result.clarifications == []


def test_obligation_item_missing_a_due_date_becomes_a_question():
    text = "I have $1,200 tuition to pay from checking, mandatory"
    result = validate(
        text,
        item(
            kind="obligation",
            fragment=text,
            name="Tuition",
            amount=1200,
            deadline=None,
            mandatory=True,
        ),
    )
    assert result.one_time_obligations == []
    assert [c.field for c in result.clarifications] == ["deadline"]


def test_obligation_item_with_no_account_named_becomes_a_question():
    text = "I have $1,200 tuition due 2027-01-15, mandatory"
    result = validate(
        text,
        item(
            kind="obligation",
            fragment=text,
            name="Tuition",
            amount=1200,
            deadline="2027-01-15",
            mandatory=True,
        ),
    )
    assert result.one_time_obligations == []
    assert [c.field for c in result.clarifications] == ["account"]


def test_obligation_amount_not_written_in_the_fragment_is_asked_about():
    """The model may not invent the number any more for an obligation than for a goal."""
    result = validate(
        TUITION,
        item(
            kind="obligation",
            fragment=TUITION,
            name="Tuition",
            amount=9999,
            deadline="2027-01-15",
            mandatory=True,
        ),
    )
    assert result.one_time_obligations == []
    assert [c.field for c in result.clarifications] == ["amount"]


def test_obligation_status_not_written_in_the_fragment_is_asked_about():
    text = "I have $1,200 tuition due 2027-01-15 from checking"
    result = validate(
        text,
        item(
            kind="obligation",
            fragment=text,
            name="Tuition",
            amount=1200,
            deadline="2027-01-15",
            mandatory=True,
        ),
    )
    assert result.one_time_obligations == []
    assert [c.field for c in result.clarifications] == ["mandatory"]


def test_unclear_item_passes_through_as_a_question():
    result = validate(
        "I want $800 for a laptop next summer",
        item(kind="unclear", fragment="I want $800 for a laptop next summer",
             question="When next summer do you need it?", question_field="deadline"),
    )
    assert [(c.field, c.question) for c in result.clarifications] == [
        ("deadline", "When next summer do you need it?")
    ]


def test_two_reserves_are_asked_about():
    text = "Keep $1,500 for emergencies. Actually keep $2,000 for emergencies"
    result = validate(
        text,
        item(kind="reserve", fragment="Keep $1,500 for emergencies", amount=1500),
        item(kind="reserve", fragment="keep $2,000 for emergencies", amount=2000),
    )
    assert result.constraints == []
    assert [c.field for c in result.clarifications] == ["amount"]


def test_goal_ids_stay_unique():
    text = "I need $100 for books by January and $200 for books by March"
    result = validate(
        text,
        item(fragment="I need $100 for books by January", name="Books", amount=100),
        item(fragment="$200 for books by March", name="Books", amount=200),
    )
    assert [g.id for g in result.goals] == ["goal_books", "goal_books_2"]


def test_unparsed_keeps_only_words_from_the_text():
    result = validate("I like cats. I need $500 for books by January", unparsed=["I like cats", "made up"])
    assert result.unparsed == ["I like cats"]


# --- compile_goals_auto -------------------------------------------------------------


def test_rules_by_default_without_calling_the_llm(monkeypatch):
    monkeypatch.delenv("GOAL_COMPILER", raising=False)

    def boom(text, as_of):
        raise AssertionError("LLM should not be called")

    assert compile_goals_auto("alex", ALEX, AS_OF, extract=boom).compiler == "rules"


def test_llm_needs_a_key(monkeypatch):
    monkeypatch.setenv("GOAL_COMPILER", "llm")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert compile_goals_auto("alex", ALEX, AS_OF, extract=lambda t, d: None).compiler == "rules"


def test_llm_path_when_enabled(llm_on):
    draft = LlmDraft(items=[item(kind="reserve", fragment="keep at least $1,500 for emergencies", amount=1500)],
                     unparsed=[])
    result = compile_goals_auto("alex", ALEX, AS_OF, extract=lambda t, d: draft)
    assert result.compiler == "llm"
    assert [c.amount for c in result.constraints] == [1500]


def test_api_failure_falls_back_to_rules(llm_on):
    def down(text, as_of):
        raise anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com"))

    result = compile_goals_auto("alex", ALEX, AS_OF, extract=down)
    assert result.compiler == "rules"
    assert len(result.goals) == 1


def test_unexpected_error_falls_back_to_rules(llm_on):
    def broken(text, as_of):
        raise KeyError("items")

    assert compile_goals_auto("alex", ALEX, AS_OF, extract=broken).compiler == "rules"


def test_a_malformed_draft_falls_back_to_rules(llm_on):
    """A fake returning the wrong shape must not take the obligation down with it."""

    def malformed(text, as_of):
        return LlmDraft.model_validate({"items": [{"kind": "obligation"}], "unparsed": []})

    result = compile_goals_auto("alex", TUITION, AS_OF, extract=malformed, accounts=load_twin().accounts)
    assert result.compiler == "rules"
    assert [o.name for o in result.one_time_obligations] == ["Tuition"]


def test_a_timeout_falls_back_to_rules_and_says_so(llm_on):
    def slow(text, as_of):
        raise anthropic.APITimeoutError(request=httpx.Request("POST", "https://api.anthropic.com"))

    result = compile_goals_auto("alex", TUITION, AS_OF, extract=slow, accounts=load_twin().accounts)
    assert result.compiler == "rules"  # honest about which compiler actually answered
    assert [o.name for o in result.one_time_obligations] == ["Tuition"]


def test_claude_call_uses_sonnet_5_with_thinking_off(monkeypatch):
    calls = []

    class FakeMessages:
        def parse(self, **kwargs):
            calls.append(kwargs)
            return type("Response", (), {"parsed_output": LlmDraft(items=[], unparsed=[])})()

    class FakeClient:
        def __init__(self, **kwargs):
            self.messages = FakeMessages()

    monkeypatch.setattr(llm_goal_compiler.anthropic, "Anthropic", FakeClient)
    llm_goal_compiler.extract_with_claude(ALEX, AS_OF)
    [call] = calls
    assert call["model"] == "claude-sonnet-5"
    assert call["thinking"] == {"type": "disabled"}


def test_empty_llm_answer_falls_back_to_rules(llm_on):
    assert compile_goals_auto("alex", ALEX, AS_OF, extract=lambda t, d: None).compiler == "rules"


def test_compile_endpoint_uses_rules_with_default_env(monkeypatch):
    monkeypatch.delenv("GOAL_COMPILER", raising=False)
    response = TestClient(app).post("/goals/compile", json={"user_id": "alex", "text": ALEX})
    assert response.status_code == 200
    assert response.json()["compiler"] == "rules"
