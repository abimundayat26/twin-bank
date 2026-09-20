"""Every amount form the deterministic path must read (frontend/SPEC.md 8.5, AS-6).

The Assistant's floor is the rules compiler, so what it cannot read it cannot draft.
Section 8.1 measured two failures that live here rather than in the Assistant:
"trying to put away around two thousand" produced nothing, and "never go under 300 in
checking" asked for an amount the sentence already gave. Both are amount parsing.

The negatives matter as much as the positives. A bare number was not money before
this, so nothing had to tell a day of the month from a dollar. Now something does.
"""

from datetime import date

import pytest

from backend.goal_compiler import (
    compile_goals,
    iter_amounts,
    parse_amount,
    word_number,
)

AS_OF = date(2026, 9, 19)


def amounts(text: str) -> list[float]:
    return [parse_amount(m) for m in iter_amounts(text)]


# The list in 8.5, one row per form.
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("$2,000", 2000),
        ("2000", 2000),
        ("2000 dollars", 2000),
        ("2k", 2000),
        ("$2.5k", 2500),
        ("1.2k", 1200),
        ("two thousand", 2000),
        ("fifteen hundred", 1500),
        ("a grand", 1000),
        ("2 grand", 2000),
    ],
)
def test_every_form_in_the_spec_is_read(text, expected):
    assert amounts(text) == [expected]


@pytest.mark.parametrize("hedge", ["around", "about", "roughly", "~"])
def test_a_hedge_in_front_does_not_hide_the_amount(hedge):
    joiner = "" if hedge == "~" else " "
    assert amounts(f"{hedge}{joiner}2000") == [2000]
    assert amounts(f"{hedge}{joiner}$2,000") == [2000]


def test_a_hedge_in_front_of_number_words_is_read_too():
    """The measured failure in 8.1: this produced nothing at all."""
    assert amounts("trying to put away around two thousand for spring break") == [2000]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("twenty five hundred", 2500),
        ("a hundred", 100),
        ("one thousand", 1000),
        ("ninety nine thousand", 99000),
    ],
)
def test_number_words_combine_with_their_scale(text, expected):
    assert amounts(text) == [expected]


def test_word_number_reads_the_parts_it_knows():
    assert word_number("fifteen") == 15
    assert word_number("twenty-five") == 25
    assert word_number("a") == 1


def test_number_words_without_a_scale_are_not_money():
    """"two laptops" is a count. Only a scale word makes number words an amount."""
    assert amounts("I want two laptops") == []
    assert amounts("fifteen of them") == []


# --- Not money: dates, periods and the rest ----------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "i owe tuition due Jan 15",
        "by May 2027",
        "by Dec 12, 2027",
        "by 2027-05-01",
        "on 10/15",
        "by the 15th of January",
        "in 6 months",
        "in 3 weeks",
        "in 1 year",
        "by 2027",
        "10% of my pay",
        "asdf",
    ],
)
def test_a_date_or_a_period_is_not_an_amount(text):
    assert amounts(text) == []


def test_a_date_beside_an_amount_leaves_the_amount_alone():
    assert amounts("i owe tuition, $1,200 due Jan 15") == [1200]
    assert amounts("save 1500 by May 2027") == [1500]
    assert amounts("I need $500 for a trip by Dec 12, 2027") == [500]


def test_a_year_sized_number_is_still_money_when_nothing_dates_it():
    """2000 is both a plausible year and the spec's own example amount."""
    assert amounts("save 2000 for a trip") == [2000]


# --- What the compiler does with them ----------------------------------------


def test_a_bare_amount_now_answers_the_question_it_used_to_ask():
    """8.1 measured this asking for an amount that is already in the sentence."""
    compiled = compile_goals("alex", "make sure I never go under 300 in checking", AS_OF)
    [constraint] = compiled.constraints
    assert constraint.type == "minimum_checking_balance"
    assert constraint.amount == 300
    assert compiled.clarifications == []


def test_a_goal_can_be_written_without_a_dollar_sign():
    compiled = compile_goals("alex", "save 2000 for a trip by 2027-06-01", AS_OF)
    [goal] = compiled.goals
    assert (goal.name, goal.target_amount, goal.deadline) == ("Trip", 2000, date(2027, 6, 1))
    assert compiled.clarifications == []


def test_a_goal_can_be_written_in_words():
    compiled = compile_goals("alex", "save two thousand for a trip by 2027-06-01", AS_OF)
    [goal] = compiled.goals
    assert goal.target_amount == 2000


def test_an_amount_in_words_still_counts_as_two_amounts():
    """The "which did you mean" guard must not be escaped by spelling one out."""
    compiled = compile_goals("alex", "save two thousand or $500 for a trip", AS_OF)
    assert compiled.goals == []
    assert [c.field for c in compiled.clarifications] == ["amount"]
