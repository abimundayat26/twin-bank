"""Which kind of declaration the user just made.

`frontend/SPEC.md` 3.2 gives the Assistant one job before anything else: work out
whether the user is describing a goal, a constraint, a one-time obligation, or an
answer about a recurring obligation TwinBank already detected -- and ask when it
cannot tell, rather than choosing silently.

That decision is made here, in code. It is not a model call and must not become
one: routing a declaration is not translation, and CLAUDE.md keeps financial
decisions deterministic. The module is pure functions over text plus the twin's
detected obligations, so every case is testable without a network.

The words themselves are reused from `goal_compiler`, so a clause can never be
routed by one set of rules and then compiled by another.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from backend.schemas import FinancialObligation, ObligationCategory

# The vocabulary each kind of declaration is recognised by. It lives here rather
# than in `goal_compiler` so that a clause can never be routed by one set of words
# and then compiled by another -- the compiler imports these back.
RESERVE_WORDS = re.compile(r"\b(?:emergenc(?:y|ies)|reserve|rainy[- ]day|safety net|cushion)\b", re.I)
CHECKING_WORDS = re.compile(r"\bchecking\b", re.I)
FLOOR_WORDS = re.compile(
    r"\b(?:keep|at least|minimum|never\s+(?:drop|go|fall|dip)|below|under|leave)\b", re.I
)
GOAL_WORDS = re.compile(r"\b(?:need|save|saving|want|goal|fund|put aside|set aside)\b", re.I)
# An expense already owed, as opposed to money being saved toward something. "pay" is
# deliberately in here although it is weak on its own: "I need to pay $400" matches
# this *and* GOAL_WORDS, and an ambiguous clause must be asked about, not guessed.
OBLIGATION_WORDS = re.compile(
    r"\b(?:owe|owes|owed|due|bill|bills|invoice|premium|tuition|pay|pays|paid)\b", re.I
)

Intent = Literal[
    "goal",
    "constraint",
    "one_time_obligation",
    "obligation_classification",
    "nothing",
    "ambiguous",
]

# How each intent is named back to the user when two of them match at once.
INTENT_PHRASE: dict[Intent, str] = {
    "goal": "a goal you are saving toward",
    "constraint": "a limit you want to keep at all times",
    "one_time_obligation": "an expense you already owe",
    "obligation_classification": "an answer about a payment TwinBank already detected",
}

# What the user calls each category. Only words that pick out one category: "payment"
# is left out on purpose, because it says nothing about which kind this is.
CATEGORY_WORDS: dict[ObligationCategory, re.Pattern[str]] = {
    "savings_transfer": re.compile(r"\b(?:savings|saving\s+up|nest\s+egg)\b", re.I),
    "debt_repayment": re.compile(
        r"\b(?:loan|loans|debt|repayment|repaying|credit\s+card|paying\s+(?:it\s+)?off)\b", re.I
    ),
    "not_recurring": re.compile(
        r"\b(?:not\s+recurring|one[-\s]off|one[-\s]time|does\s?n[o']t\s+repeat|won'?t\s+happen\s+again)\b",
        re.I,
    ),
    "optional_spending": re.compile(
        r"\b(?:optional|discretionary|could\s+cancel|don'?t\s+need|nice\s+to\s+have)\b", re.I
    ),
    # Not "rent" or "utilities": those name obligations, they do not classify them.
    "bill": re.compile(r"\b(?:bill|bills|essential|must[-\s]pay|have\s+to\s+pay\s+it)\b", re.I),
}
# Ordered most specific first, so "an optional subscription" is optional_spending and
# not a bill. A tie between two categories is an ambiguity, not a pick.
CATEGORY_ORDER: tuple[ObligationCategory, ...] = (
    "not_recurring",
    "optional_spending",
    "debt_repayment",
    "savings_transfer",
    "bill",
)

# Words in an obligation's name that pick nothing out.
STOP_NAME_WORDS = frozenset(
    "the a an of and or for to plan payment recurring monthly unclear purpose "
    "possibly destination".split()
)


@dataclass(frozen=True)
class Routing:
    """One clause, and what it turned out to be."""

    intent: Intent
    fragment: str
    # Set only when intent is "ambiguous": what to ask instead of choosing.
    question: str | None = None
    # Set only when intent is "obligation_classification".
    obligation_id: str | None = None
    category: ObligationCategory | None = None


def name_tokens(obligation: FinancialObligation) -> set[str]:
    """The words in an obligation's name a user might actually say back."""
    words = re.findall(r"[a-z]+", obligation.name.lower())
    return {w for w in words if len(w) >= 4 and w not in STOP_NAME_WORDS}


def referenced_obligation(
    clause: str, obligations: Sequence[FinancialObligation]
) -> FinancialObligation | None:
    """The detected obligation this clause names, if exactly one is named.

    Matched on the words of its name, because that is what the user has been shown.
    Two matches is not a reference: it is an ambiguity for the caller to handle.

    `clause` should already have the category phrase stripped out. Otherwise
    "that thing is savings" matches the transfer whose *name* happens to contain the
    word "savings", which is a reference to nothing.
    """
    said = set(re.findall(r"[a-z]+", clause.lower()))
    matched = [o for o in obligations if name_tokens(o) & said]
    return matched[0] if len(matched) == 1 else None


def stated_category(clause: str) -> ObligationCategory | None:
    """The one category this clause picks out, or None if it picks none or several."""
    matched = [c for c in CATEGORY_ORDER if CATEGORY_WORDS[c].search(clause)]
    return matched[0] if matched else None


def looks_like_constraint(clause: str) -> bool:
    """A standing limit rather than a target: "keep at least $300 in checking"."""
    return bool(FLOOR_WORDS.search(clause)) and bool(
        RESERVE_WORDS.search(clause) or CHECKING_WORDS.search(clause)
    )


def ask_which(candidates: list[Intent]) -> str:
    """The question to ask when a clause reads as more than one kind of declaration."""
    phrases = [INTENT_PHRASE[i] for i in candidates]
    joined = ", ".join(phrases[:-1]) + f", or {phrases[-1]}"
    return f"Is this {joined}?"


def route_clause(clause: str, obligations: Sequence[FinancialObligation] = ()) -> Routing:
    """What one clause is. Never a guess between two readings: that is "ambiguous"."""
    text = clause.strip()
    if not text:
        return Routing(intent="nothing", fragment=clause)

    category = stated_category(text)
    # The words that expressed the category are spent. Reading them a second time as
    # evidence of something else invents an ambiguity: in "the rent is a bill", "bill"
    # is the category, not a separate declaration that a bill is owed.
    rest = CATEGORY_WORDS[category].sub(" ", text) if category else text
    obligation = referenced_obligation(rest, obligations) if category else None
    remaining = rest if obligation is not None else text

    candidates: list[Intent] = []
    if obligation is not None:
        candidates.append("obligation_classification")
    if looks_like_constraint(remaining):
        candidates.append("constraint")
    if GOAL_WORDS.search(remaining):
        candidates.append("goal")
    if OBLIGATION_WORDS.search(remaining):
        candidates.append("one_time_obligation")

    if not candidates:
        return Routing(intent="nothing", fragment=text)
    if len(candidates) > 1:
        return Routing(intent="ambiguous", fragment=text, question=ask_which(candidates))

    [only] = candidates
    if only == "obligation_classification":
        assert obligation is not None
        return Routing(
            intent="obligation_classification",
            fragment=text,
            obligation_id=obligation.id,
            category=category,
        )
    return Routing(intent=only, fragment=text)


def route_clauses(
    clauses: Sequence[str], obligations: Sequence[FinancialObligation] = ()
) -> list[Routing]:
    """Each clause, in the order the user wrote them.

    Takes clauses rather than raw text: splitting a sentence needs the amount rules,
    which belong to the compiler. `goal_compiler.split_clauses` does that part.
    """
    return [route_clause(clause, obligations) for clause in clauses]
