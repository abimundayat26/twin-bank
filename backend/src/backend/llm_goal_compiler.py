"""LLM goal compiler: Claude drafts, code decides.

The LLM only reads the user's text and proposes draft items. Every item is then
checked in code before it can become a Goal or FinancialConstraint (SPEC section 6:
the LLM must not invent goals or financial facts):
- its fragment must be words the user actually wrote,
- its amount must be a number written in that fragment,
- its deadline goes through the same checks as the rules compiler, and a date the
  rules can read from the fragment wins over the LLM's reading.
Anything that fails a check becomes a clarification question instead of a guess.

Off by default. GOAL_COMPILER=llm plus ANTHROPIC_API_KEY turns it on; without them,
or when the call fails, /goals/compile uses the rules compiler (compiler="rules").
"""

import logging
import os
from collections.abc import Callable, Sequence
from datetime import date
from typing import Literal

import anthropic
from pydantic import BaseModel, ValidationError

from backend.goal_compiler import (
    CHECKING_FLOOR_ID,
    DUE_WORDS,
    RESERVE_ID,
    check_deadline,
    MAX_AMOUNT,
    check_due_date,
    compile_goals,
    dedupe_constraints,
    funding_account,
    iter_amounts,
    money,
    obligation_status,
    parse_amount,
    parse_deadline,
    unique_goal_id,
    unique_obligation_id,
)
from backend.schemas import (
    Account,
    FinancialConstraint,
    FinancialObligation,
    Goal,
    GoalClarification,
    GoalClarificationField,
    GoalCompileResponse,
    OneTimeObligation,
)

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-sonnet-5"
# One attempt, well inside the frontend's 8 s request timeout, so a slow call
# falls back to the rules compiler instead of hanging the UI.
TIMEOUT_SECONDS = 6


class LlmItem(BaseModel):
    kind: Literal["goal", "reserve", "checking_floor", "obligation", "unclear"]
    fragment: str
    name: str | None
    amount: float | None
    deadline: str | None
    question: str | None
    question_field: GoalClarificationField | None
    mandatory: bool | None = None


class LlmDraft(BaseModel):
    items: list[LlmItem]
    unparsed: list[str]


SYSTEM_PROMPT = """You turn what a user wrote about their money into draft savings goals and constraints.
Only extract what the user actually said. Never invent an amount, a date, or a goal.

For each thing the user asks for, add one item:
- kind "goal": money to have saved by a deadline ("$2,000 for summer housing by May").
- kind "reserve": an emergency reserve to keep across checking and savings at all times.
- kind "checking_floor": a minimum balance to keep in checking alone.
- kind "obligation": a one-off expense the user already owes on a known date ("$1,200
  tuition due January 15"), as opposed to money they are saving toward. Put the due date
  in deadline. If it could be either a goal or an obligation, make it "unclear" with
  question_field "intent".
- kind "unclear": the user wants something but a detail is missing or ambiguous. Set question
  (one short question to the user) and question_field (amount, deadline, name, type,
  account, intent or mandatory).
Fields:
- fragment: the exact words from the text this item comes from, copied character for character.
- name: a short name for a goal ("Summer housing"), else null.
- amount: the dollar amount as a number, only if the fragment states it, else null.
- deadline: YYYY-MM-DD only if the text names a specific date or month; resolve it relative to
  today's date given below (the next such date after today). For vague timing ("next summer",
  "soon", "someday") set deadline to null and make the item "unclear" with question_field "deadline".
- mandatory: true or false only if the fragment explicitly says mandatory or optional; otherwise
  set it to null and make the item "unclear" with question_field "mandatory".
Put parts of the text that ask for nothing in unparsed, copied exactly."""


def llm_enabled() -> bool:
    return os.getenv("GOAL_COMPILER", "rules").lower() == "llm" and bool(os.getenv("ANTHROPIC_API_KEY"))


def extract_with_claude(text: str, as_of: date) -> LlmDraft | None:
    """One Claude call. None when the model returns nothing usable (refusal, cut off)."""
    client = anthropic.Anthropic(timeout=TIMEOUT_SECONDS, max_retries=0)
    response = client.messages.parse(
        model=os.getenv("LLM_MODEL") or DEFAULT_MODEL,
        max_tokens=2000,
        system=SYSTEM_PROMPT,
        # Extraction, not reasoning: thinking off keeps the call fast for the demo.
        thinking={"type": "disabled"},
        messages=[{"role": "user", "content": f"Today is {as_of.isoformat()}.\n\nText:\n{text}"}],
        output_format=LlmDraft,
    )
    return response.parsed_output


def draft_llm_obligation(
    item: LlmItem,
    fragment: str,
    name: str,
    as_of: date,
    accounts: Sequence[Account],
    drafted: list[OneTimeObligation],
    ask: Callable[[str, str, str], None],
) -> None:
    """The obligation half of validate_draft, under the same rule: code checks every fact.

    The amount has already been matched against the fragment by the caller. The due
    date goes through the rules parser first and only falls back to the model's
    reading when the rules found no timing words at all, exactly as goals do.
    """
    assert item.amount is not None
    what = f"the {name.lower()}"
    normalized = DUE_WORDS.sub("by", fragment)
    due, due_words = parse_deadline(normalized, as_of)
    if due is None and due_words is None and item.deadline:
        try:
            due = date.fromisoformat(item.deadline)
        except ValueError:
            due = None
    question = check_due_date(due, due_words, what, as_of)
    if question is not None:
        ask("deadline", question, fragment)
        return

    account_id, account_question = funding_account(normalized, accounts)
    if account_question:
        ask("account", account_question, fragment)
        return

    mandatory = obligation_status(fragment)
    if mandatory is None or item.mandatory is not mandatory:
        ask("mandatory", f"Is {what} mandatory or optional?", fragment)
        return

    assert due is not None and account_id is not None
    drafted.append(
        OneTimeObligation(
            id=unique_obligation_id(name, {o.id for o in drafted}),
            name=name[:1].upper() + name[1:],
            amount=item.amount,
            due_date=due,
            account_id=account_id,
            mandatory=mandatory,
        )
    )


def validate_draft(
    user_id: str,
    text: str,
    as_of: date,
    draft: LlmDraft,
    accounts: Sequence[Account] = (),
) -> GoalCompileResponse:
    """Turn the LLM's draft into goals and constraints, or questions, using only code-checked facts."""
    goals: list[Goal] = []
    constraints: list[FinancialConstraint] = []
    obligations: list[OneTimeObligation] = []
    clarifications: list[GoalClarification] = []

    def ask(field, question: str, fragment: str) -> None:
        clarifications.append(GoalClarification(field=field, question=question, fragment=fragment))

    lowered = text.lower()
    for item in draft.items:
        fragment = item.fragment.strip()
        if not fragment or fragment.lower() not in lowered:
            logger.warning("LLM goal compiler: dropped an item whose fragment is not in the text: %r", fragment)
            continue

        if item.kind == "unclear":
            ask(item.question_field or "type", item.question or "Can you say more about this?", fragment)
            continue

        written = [parse_amount(m) for m in iter_amounts(fragment)]
        name = (item.name or "").strip()
        what = f"for {name}" if name else "for this"
        # V2, over both paths: positive, written in the fragment, and small enough to be real.
        if (
            item.amount is None
            or item.amount <= 0
            or item.amount > MAX_AMOUNT
            or item.amount not in written
        ):
            ask("amount", f"How much do you need {what}?", fragment)
            continue

        if item.kind == "reserve":
            constraints.append(
                FinancialConstraint(
                    id=RESERVE_ID,
                    type="minimum_reserve",
                    amount=item.amount,
                    description=f"Keep at least {money(item.amount)} across checking and "
                    "savings for emergencies.",
                )
            )
            continue
        if item.kind == "checking_floor":
            constraints.append(
                FinancialConstraint(
                    id=CHECKING_FLOOR_ID,
                    type="minimum_checking_balance",
                    amount=item.amount,
                    description=f"Keep at least {money(item.amount)} in checking.",
                )
            )
            continue

        if not name:
            ask("name", f"What is {money(item.amount)} for?", fragment)
            continue

        if item.kind == "obligation":
            draft_llm_obligation(item, fragment, name, as_of, accounts, obligations, ask)
            continue

        deadline, deadline_words = parse_deadline(fragment, as_of)
        if deadline is None and deadline_words is None and item.deadline:
            # The rules found no timing words at all, so take the LLM's reading of the date.
            try:
                deadline = date.fromisoformat(item.deadline)
            except ValueError:
                deadline = None
        question = check_deadline(deadline, deadline_words, what, as_of)
        if question is not None:
            ask("deadline", question, fragment)
            continue
        assert deadline is not None
        goal_id = unique_goal_id(name, {g.id for g in goals})
        goals.append(
            Goal(id=goal_id, name=name[:1].upper() + name[1:], target_amount=item.amount, deadline=deadline)
        )

    constraints = dedupe_constraints(constraints, text, ask)
    unparsed = [u.strip() for u in draft.unparsed if u.strip() and u.strip().lower() in lowered]
    return GoalCompileResponse(
        user_id=user_id,
        text=text,
        goals=goals,
        constraints=constraints,
        one_time_obligations=obligations,
        clarifications=clarifications,
        unparsed=unparsed,
        compiler="llm",
    )


def compile_goals_auto(
    user_id: str,
    text: str,
    as_of: date,
    extract: Callable[[str, date], LlmDraft | None] = extract_with_claude,
    accounts: Sequence[Account] = (),
    detected: Sequence[FinancialObligation] = (),
) -> GoalCompileResponse:
    """The LLM compiler when enabled, else (or when it fails) the rules compiler.

    Note the LLM path drafts no obligation classifications: its item kinds do not
    include one, so an answer about a detected obligation is only recognised by the
    rules compiler. GOAL_COMPILER is "rules" by default, and every fallback below
    lands there, so the demo is unaffected.
    """
    if not llm_enabled():
        return compile_goals(user_id, text, as_of, accounts, detected)
    try:
        draft = extract(text, as_of)
        if draft is None:
            logger.warning("LLM goal compiler returned no draft, using rules")
            return compile_goals(user_id, text, as_of, accounts, detected)
        return validate_draft(user_id, text, as_of, draft, accounts)
    except (anthropic.APIError, ValidationError) as e:
        logger.warning("LLM goal compiler failed, using rules: %s", e)
    except Exception:
        # Anything else (an SDK change, a draft shape validate_draft does not expect)
        # must still not break the demo.
        logger.exception("LLM goal compiler crashed, using rules")
    return compile_goals(user_id, text, as_of, accounts, detected)
