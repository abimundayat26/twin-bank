"""The Assistant's model seam, driven only by an injected fake `extract`.

`frontend/SPEC.md` section 13 asks for this file by name: a valid draft, a malformed
one, a timeout, extra fields, a fragment the user never wrote, and an id the model
tried to choose. `test_llm_goal_compiler.py` covers the same checks inside the
compiler; what is here is the Assistant's behaviour on top of them -- what `read_by`
says, which reply template comes back, and that the twin is untouched either way.

**No real call is made or possible.** Every test passes its own `extract`, so the
Anthropic client is never constructed; `test_the_client_is_never_constructed` makes
that a failure rather than a hope. The key in `llm_on` is a fixed dummy string, set
on the process only for the duration of one test, which is the convention
`test_llm_goal_compiler.py` already uses: `llm_enabled()` needs to see a key present
before it will take the injected path at all.
"""

from datetime import date

import anthropic
import httpx
import pytest

from backend import assistant, twin_store
from backend.fixtures import load_twin
from backend.llm_goal_compiler import LlmDraft, LlmItem

TRIP = "I want to save $2,000 for a trip by next June"
FRAGMENT = "save $2,000 for a trip by next June"


@pytest.fixture
def llm_on(monkeypatch):
    """The model path turned on for one test, with a dummy key and no client."""
    monkeypatch.setenv("GOAL_COMPILER", "llm")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "not-a-real-key")
    monkeypatch.setattr(
        anthropic, "Anthropic", _never("the Anthropic client was constructed in a test")
    )


def _never(message: str):
    def refuse(*args, **kwargs):
        raise AssertionError(message)

    return refuse


def draft(**overrides) -> LlmDraft:
    """A well-formed draft of the trip goal, for a test to spoil one field of."""
    item = {
        "kind": "goal",
        "fragment": FRAGMENT,
        "name": "Trip",
        "amount": 2000.0,
        "deadline": "2027-06-01",
        "question": None,
        "question_field": None,
    } | overrides
    return LlmDraft(items=[LlmItem(**item)], unparsed=[])


def returning(value):
    return lambda _text, _as_of: value


def read(extract, text: str = TRIP):
    return assistant.read_message(load_twin(), text, extract=extract)


# --- A draft the code accepts -------------------------------------------------


def test_a_valid_draft_becomes_a_card_the_user_must_accept(llm_on):
    before = twin_store.get_twin()
    reading = read(returning(draft()))
    assert reading.read_by == "model"
    assert reading.reply == assistant.REPLY_PROPOSALS
    [proposal] = reading.proposals
    assert proposal.goal.target_amount == 2000
    assert proposal.goal.deadline == date(2027, 6, 1)
    assert proposal.requires_user_confirmation is True
    # AS-1: reading it changed nothing, whoever read it.
    assert twin_store.get_twin() == before


def test_extra_fields_the_model_invents_are_ignored(llm_on):
    """A newer model returning more than the schema asks for must not break the read."""
    raw = {
        "items": [
            {
                "kind": "goal",
                "fragment": FRAGMENT,
                "name": "Trip",
                "amount": 2000.0,
                "deadline": "2027-06-01",
                "question": None,
                "question_field": None,
                "confidence": 0.91,
                "rationale": "the user said trip",
            }
        ],
        "unparsed": [],
        "model_notes": "none",
    }
    reading = read(returning(LlmDraft.model_validate(raw)))
    assert reading.read_by == "model"
    [proposal] = reading.proposals
    assert proposal.goal.target_amount == 2000


def test_an_id_the_model_chose_is_ignored(llm_on):
    """V5: ids are assigned by code, so a model cannot aim a draft at an existing goal."""
    raw = {
        "items": [
            {
                "kind": "goal",
                "fragment": FRAGMENT,
                "name": "Trip",
                "amount": 2000.0,
                "deadline": "2027-06-01",
                "question": None,
                "question_field": None,
                "id": "goal_summer_housing",
                "goal_id": "goal_summer_housing",
            }
        ],
        "unparsed": [],
    }
    [proposal] = read(returning(LlmDraft.model_validate(raw))).proposals
    assert proposal.goal.id == "goal_trip"
    # The goal Alex already has is not what the card points at.
    assert proposal.goal.name == "Trip"


# --- Drafts the code refuses --------------------------------------------------


def test_a_quote_the_user_never_wrote_is_dropped(llm_on):
    """V1: the card quotes the user, so a fragment they did not type cannot be shown."""
    ghost = draft(fragment="words the user never typed", name="Ghost", amount=9999.0)
    reading = read(returning(ghost))
    assert reading.proposals == []
    assert reading.reply == assistant.REPLY_NOTHING


def test_an_amount_not_written_in_the_fragment_is_asked_about(llm_on):
    """V2: the number has to be in the words it claims to come from."""
    reading = read(returning(draft(amount=5000.0)))
    assert reading.proposals == []
    assert [q.field for q in reading.questions] == ["amount"]
    assert reading.reply == assistant.REPLY_QUESTIONS


def test_an_amount_over_the_limit_is_asked_about(llm_on):
    """V2's upper bound holds over the model path as well as the rules path."""
    text = "save $5,000,000 for a house by 2027-06-01"
    big = draft(fragment=text, name="House", amount=5_000_000.0)
    reading = read(returning(big), text)
    assert reading.proposals == []
    assert [q.field for q in reading.questions] == ["amount"]


# --- When the model does not answer -------------------------------------------


def test_a_malformed_draft_falls_back_to_rules_and_says_so(llm_on):
    """The wrong shape entirely: the message is still read, by the rules (AS-16)."""
    reading = read(returning({"items": "not a list"}))
    assert reading.read_by == "rules"
    assert reading.reply.startswith(assistant.MODEL_FALLBACK_PREFIX)
    [proposal] = reading.proposals
    assert proposal.goal.target_amount == 2000


def test_a_timeout_falls_back_to_rules_and_says_so(llm_on):
    def slow(_text, _as_of):
        raise anthropic.APITimeoutError(request=httpx.Request("POST", "https://example.invalid"))

    reading = read(slow)
    assert reading.read_by == "rules"
    assert reading.reply.startswith(assistant.MODEL_FALLBACK_PREFIX)
    assert len(reading.proposals) == 1


def test_no_draft_at_all_falls_back_to_rules(llm_on):
    reading = read(returning(None))
    assert reading.read_by == "rules"
    assert reading.reply.startswith(assistant.MODEL_FALLBACK_PREFIX)


def test_an_unreachable_model_still_reads_the_message(llm_on):
    def down(_text, _as_of):
        raise RuntimeError("the model is unreachable")

    reading = read(down)
    assert reading.read_by == "rules"
    assert reading.reply.startswith(assistant.MODEL_FALLBACK_PREFIX)
    assert len(reading.proposals) == 1


# --- No network, ever ---------------------------------------------------------


def test_the_client_is_never_constructed(llm_on):
    """`llm_on` makes constructing the Anthropic client an error; every path above ran."""
    for extract in (returning(draft()), returning(None), returning({"items": 1})):
        read(extract)


def test_without_the_environment_the_injected_extract_is_not_even_called():
    """AS-16: the default is rules, so a fake model is not consulted either."""
    reading = read(_never("extract was called with GOAL_COMPILER unset"))
    assert reading.read_by == "rules"
    assert len(reading.proposals) == 1
