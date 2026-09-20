"""The Assistant: it drafts, and only the user's Accept changes anything.

`frontend/SPEC.md` section 8 is the contract. The shape of it:

* A message is read by the **rules** compiler by default and by a model only when
  the group lead turns one on (AS-16). Either way the result is the same
  `GoalCompileResponse`, and either way every field in it was checked by code
  before it got here (AS-5, section 8.4).
* Nothing this module returns has touched the twin (AS-1). A draft becomes a
  `Proposal` with an id; `apply_proposal` is the only function here that writes,
  and only `POST /assistant/proposals/{id}/decision` calls it (AS-15).
* Every `reply` string comes from the templates below, never from a model (AS-3).
  The only words of the user's that come back are `source_fragment` quotes, which
  are checked to be substrings of what they typed (V1).

Two things the compiler does not do are done here, because they are the
Assistant's job rather than the goal compiler's: routing a what-if to the Purchase
Simulator without running it (AS-8), and turning "change my summer housing goal to
$2,500" into an update of something the twin already has (V7, V8).
"""

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Protocol, TypeVar

from backend import twin_store
from backend.assistant_store import new_id
from backend.goal_compiler import (
    check_deadline,
    check_due_date,
    iter_amounts,
    money,
    parse_amount,
    parse_deadline,
    slug,
    split_clauses,
    strip_amounts,
    unique_goal_id,
    unique_obligation_id,
)
from backend.llm_goal_compiler import LlmDraft, compile_goals_auto, llm_enabled
from backend.schemas import (
    AddGoalProposal,
    AddObligationProposal,
    AssistantQuestion,
    ClassifyObligationProposal,
    FinancialConstraint,
    FinancialTwin,
    GoalChanges,
    GoalCompileResponse,
    ObligationCategory,
    OneTimeObligationChanges,
    Proposal,
    RecurringObligationChanges,
    SetConstraintProposal,
    SimulatePrefill,
    UpdateGoalProposal,
    UpdateObligationProposal,
)

MAX_PROPOSALS_PER_REPLY = 5
MAX_QUESTIONS_PER_REPLY = 3

# --- Reply and question templates (8.3) --------------------------------------

REPLY_PROPOSALS = "Here is what I understood. Nothing changes until you accept."
REPLY_QUESTIONS = "I need a bit more before I can draft this."
REPLY_BOTH = "I drafted what I could and need one more detail for the rest."
REPLY_WHAT_IF = "That sounds like a what-if. I've filled in the Purchase Simulator for you."
REPLY_NOTHING = (
    "I couldn't turn that into a goal, a limit, a bill or a what-if. "
    "For example: “Save $2,000 for a trip by June 1”."
)
REPLY_DUPLICATE = "That's already in your plan."
MODEL_FALLBACK_PREFIX = "The model was unavailable, so this was read by rules. "
OVER_FIVE_SUFFIX = " I read the first five."

QUESTION_WHICH_ONE = "Which one do you mean: {names}?"
QUESTION_CATEGORY = "What is {name} ({amount} a month)?"

# Mirrors frontend/components/CategoryQuestion.tsx, so a quick reply reads the same
# as the button the user would have pressed on the Obligations page.
CATEGORY_LABELS: dict[ObligationCategory, str] = {
    "bill": "Bill",
    "savings_transfer": "Savings transfer",
    "debt_repayment": "Debt repayment",
    "optional_spending": "Optional spending",
    "not_recurring": "Not recurring",
}

MANDATORY_CHOICES = ["Mandatory", "Optional"]


class HasName(Protocol):
    id: str
    name: str


Named = TypeVar("Named", bound=HasName)


class ExpiredQuestion(Exception):
    """`in_reply_to` names a question this process no longer holds (AS-11)."""


class NotApplicable(Exception):
    """What an accepted proposal pointed at is gone or no longer valid (AS-15)."""


@dataclass
class Reading:
    """Everything one user message produced, before the route gives it ids."""

    reply: str
    read_by: str
    proposals: list[Proposal] = field(default_factory=list)
    questions: list[AssistantQuestion] = field(default_factory=list)
    simulate_prefill: SimulatePrefill | None = None
    unparsed: list[str] = field(default_factory=list)


# --- Opening questions (AS-9) -------------------------------------------------


def opening_questions(twin: FinancialTwin) -> list[AssistantQuestion]:
    """At most two unclassified detected payments, largest first.

    Choices are the candidate categories in the order the detector ranked them,
    named in words and without their probabilities (G-5).
    """
    unclear = [
        o for o in twin.obligations if o.category_candidates and o.declared_category is None
    ]
    unclear.sort(key=lambda o: o.expected_amount, reverse=True)
    return [
        AssistantQuestion(
            question_id=new_id("q"),
            text=QUESTION_CATEGORY.format(name=o.name, amount=money(o.expected_amount)),
            field="category",
            choices=[CATEGORY_LABELS[c.category] for c in o.category_candidates],
            fragment=o.name,
        )
        for o in unclear[:2]
    ]


# --- What-if routing (AS-8) ---------------------------------------------------

WHAT_IF = re.compile(
    r"\bwhat\s+if\s+(?:i|we)\s+(?:buy|bought|get|got|purchase|purchased|pay\s+for|paid\s+for)\b"
    r"(?P<rest>.*)",
    re.I,
)
# Filler in front of the thing being bought: "a $800 laptop" -> "laptop".
WHAT_IF_LEAD = frozenset("a an the my our some that this new another".split())
# Where the thing being bought ends and when it happens begins.
WHAT_IF_TIMING = frozenset(
    "by in before within next on after around sometime soon later today tomorrow".split()
)


def what_if_description(rest: str) -> str | None:
    """The thing being bought, from the words after the verb."""
    words = [w for w in strip_amounts(rest, " ").split() if w]
    while words and words[0].lower().strip(".,") in WHAT_IF_LEAD:
        words.pop(0)
    # "in 3 months" / "by June" is timing, not the thing.
    cut = next(
        (i for i, w in enumerate(words) if w.lower() in WHAT_IF_TIMING), len(words)
    )
    name = " ".join(words[:cut]).strip(" ,.;:'\"?")
    return name[:1].upper() + name[1:] if name else None


def read_what_if(clause: str, as_of: date) -> tuple[SimulatePrefill | None, str | None, str | None]:
    """(prefill, question field, question text) for a what-if clause.

    Nothing is simulated and no probability is stated here: the Assistant fills the
    Simulator in and stops (AS-8).
    """
    match = WHAT_IF.search(clause)
    if not match:
        return None, None, None
    rest = match.group("rest")
    amounts = [parse_amount(m) for m in iter_amounts(rest)]
    description = what_if_description(rest)
    what = f"the {description.lower()}" if description else "this"
    if not amounts:
        return None, "amount", f"How much is {what}?"
    if description is None:
        return None, "name", f"What is {money(amounts[0])} for?"
    when, when_words = parse_deadline(clause, as_of)
    if when is not None and check_due_date(when, when_words, what, as_of) is not None:
        when = None
    return SimulatePrefill(description=description, amount=amounts[0], date=when), None, None


# --- Updating something the twin already has (V7, V8) -------------------------

UPDATE_WORDS = re.compile(
    r"\b(?:change|changed|update|updated|move|raise|raised|lower|lowered|increase|increased"
    r"|decrease|decreased|bump|rename|set(?!\s+aside)|went\s+up|went\s+down|goes\s+up"
    r"|goes\s+down|is\s+now)\b",
    re.I,
)
# Words in a name that pick nothing out, so "my rent bill" still resolves by "rent".
STOP_NAME_WORDS = frozenset(
    "the a an and or for to my our of new goal fund plan bill bills payment recurring "
    "monthly unclear purpose possibly destination".split()
)


TO_AS_BY = re.compile(r"\bto\b(?=\s+(?!\$|\d+(?:[.,]\d)*\s*(?:k\b|grand\b|dollars\b))\S)", re.I)


def name_words(name: str) -> set[str]:
    return {
        w for w in re.findall(r"[a-z]+", name.lower()) if len(w) >= 3 and w not in STOP_NAME_WORDS
    }


def named_in(clause: str, items: Sequence[Named]) -> list[Named]:
    """Every item of `items` whose name the clause says at least one real word of."""
    said = set(re.findall(r"[a-z]+", clause.lower()))
    return [item for item in items if name_words(item.name) & said]


def new_value(
    clause: str, as_of: date
) -> tuple[float | None, date | None, tuple[str, str] | None]:
    """(amount, date, (question field, question)). The question rules the other two out."""
    amounts = [parse_amount(m) for m in iter_amounts(clause)]
    if len(amounts) > 1:
        listed = " and ".join(money(a) for a in amounts)
        return None, None, ("amount", f"This mentions {listed}. Which amount do you mean?")
    # "change my housing goal to August 1" states a deadline the way an update is
    # phrased rather than the way a goal is, so "to" is read as "by" here only.
    when, when_words = parse_deadline(TO_AS_BY.sub("by", clause), as_of)
    if when_words and when is None:
        return None, None, ("deadline", f'When exactly is "{when_words}"? Give a date.')
    # V8: "change my trip goal" names no new value, so it is a question, not a draft.
    return (amounts[0] if amounts else None), when, None


def read_update(clause: str, twin: FinancialTwin) -> tuple[Proposal | None, AssistantQuestion | None]:
    """An update to a goal or obligation, or the question to ask instead.

    (None, None) means this clause is not an update and belongs to the compiler.
    """
    if not UPDATE_WORDS.search(clause):
        return None, None

    goals = named_in(clause, twin.goals)
    one_time = named_in(clause, twin.one_time_obligations)
    recurring = named_in(clause, twin.obligations)
    targets = goals + one_time + recurring
    if not targets:
        return None, None
    if len(targets) > 1:
        names = ", ".join(t.name for t in targets)
        return None, _ask(
            "which_one",
            QUESTION_WHICH_ONE.format(names=names),
            clause,
            choices=[t.name for t in targets],
        )

    [target] = targets
    amount, when, problem = new_value(clause, twin.as_of)
    if problem is not None:
        return None, _ask(problem[0], problem[1], clause)
    if amount is None and when is None:
        return None, _ask("amount", f"How much should {target.name} be?", clause)

    if goals:
        question = check_deadline(when, None, f"for {target.name}", twin.as_of) if when else None
        if question:
            return None, _ask("deadline", question, clause)
        changes = GoalChanges(
            **({"target_amount": amount} if amount is not None else {})
            | ({"deadline": when} if when is not None else {})
        )
        return (
            UpdateGoalProposal(
                proposal_id=new_id("prop"),
                source_fragment=clause,
                goal_id=target.id,
                goal_name=target.name,
                changes=changes,
            ),
            None,
        )

    if one_time:
        question = (
            check_due_date(when, None, f"the {target.name.lower()}", twin.as_of)
            if when
            else None
        )
        if question:
            return None, _ask("deadline", question, clause)
        changes = OneTimeObligationChanges(
            **({"amount": amount} if amount is not None else {})
            | ({"due_date": when} if when is not None else {})
        )
        return (
            UpdateObligationProposal(
                proposal_id=new_id("prop"),
                source_fragment=clause,
                obligation_id=target.id,
                obligation_name=target.name,
                kind="one_time",
                one_time_changes=changes,
            ),
            None,
        )

    if amount is None:
        return None, _ask("amount", f"How much should {target.name} be?", clause)
    return (
        UpdateObligationProposal(
            proposal_id=new_id("prop"),
            source_fragment=clause,
            obligation_id=target.id,
            obligation_name=target.name,
            kind="recurring",
            recurring_changes=RecurringObligationChanges(amount=amount),
        ),
        None,
    )


def _ask(field_name, text: str, fragment: str, choices: list[str] | None = None) -> AssistantQuestion:
    return AssistantQuestion(
        question_id=new_id("q"),
        text=text,
        field=field_name,
        choices=choices or [],
        fragment=fragment,
    )


# --- Turning compiler output into proposals -----------------------------------


def normalized(text: str) -> str:
    return " ".join(text.lower().split())


def quoted_from(fragment: str, text: str) -> bool:
    """V1: the quote has to be the user's own words, ignoring case and spacing."""
    return bool(fragment.strip()) and normalized(fragment) in normalized(text)


def fragment_for(amount: float, clauses: Sequence[str], text: str) -> str:
    """The clause an amount was written in, so a card can quote it (V1).

    The compiler reports goals and constraints without saying which words they came
    from. Matching on the amount recovers that for every realistic message, and the
    whole text is a truthful fallback rather than a guess.
    """
    for clause in clauses:
        if any(abs(parse_amount(m) - amount) < 0.005 for m in iter_amounts(clause)):
            return clause
    return text


def choices_for(field_name: str, twin: FinancialTwin) -> list[str]:
    """Quick replies, only where the answers are a closed set the twin knows."""
    if field_name == "account":
        return [a.name for a in twin.accounts]
    if field_name == "mandatory":
        return MANDATORY_CHOICES
    return []


def proposals_from(
    result: GoalCompileResponse, twin: FinancialTwin, clauses: Sequence[str]
) -> list[Proposal]:
    """Every draft the compiler produced, as a card the user can accept or reject."""
    drafted: list[Proposal] = []
    for goal in result.goals:
        drafted.append(
            AddGoalProposal(
                proposal_id=new_id("prop"),
                source_fragment=fragment_for(goal.target_amount, clauses, result.text),
                goal=goal,
            )
        )
    for constraint in result.constraints:
        drafted.append(
            SetConstraintProposal(
                proposal_id=new_id("prop"),
                source_fragment=fragment_for(constraint.amount, clauses, result.text),
                constraint=constraint,
            )
        )
    for obligation in result.one_time_obligations:
        drafted.append(
            AddObligationProposal(
                proposal_id=new_id("prop"),
                source_fragment=fragment_for(obligation.amount, clauses, result.text),
                obligation=obligation,
            )
        )
    for classification in result.classifications:
        drafted.append(
            ClassifyObligationProposal(
                proposal_id=new_id("prop"),
                source_fragment=classification.fragment,
                classification=classification,
            )
        )
    # AS-5/V1 once more, over both paths: a quote that is not the user's words is
    # not shown, whoever produced it.
    return [p for p in drafted if quoted_from(p.source_fragment, result.text)]


def already_true(proposal: Proposal, twin: FinancialTwin) -> bool:
    """AS-18: the twin already says this, so there is nothing to accept."""
    if proposal.action_type == "ADD_GOAL":
        return any(
            slug(g.name) == slug(proposal.goal.name)
            and g.target_amount == proposal.goal.target_amount
            and g.deadline == proposal.goal.deadline
            for g in twin.goals
        )
    if proposal.action_type == "SET_CONSTRAINT":
        return any(
            c.type == proposal.constraint.type and c.amount == proposal.constraint.amount
            for c in twin.constraints
        )
    if proposal.action_type == "ADD_OBLIGATION":
        return any(
            slug(o.name) == slug(proposal.obligation.name)
            and o.amount == proposal.obligation.amount
            and o.due_date == proposal.obligation.due_date
            for o in twin.one_time_obligations
        )
    if proposal.action_type == "CLASSIFY_OBLIGATION":
        return any(
            o.id == proposal.classification.obligation_id
            and o.declared_category == proposal.classification.category
            for o in twin.obligations
        )
    if proposal.action_type == "UPDATE_GOAL":
        goal = next((g for g in twin.goals if g.id == proposal.goal_id), None)
        changes = proposal.changes.model_dump(exclude_unset=True)
        return goal is not None and all(getattr(goal, k) == v for k, v in changes.items())
    if proposal.kind == "recurring":
        obligation = next(
            (o for o in twin.obligations if o.id == proposal.obligation_id), None
        )
        if obligation is None or proposal.recurring_changes is None:
            return False
        changes = proposal.recurring_changes.model_dump(exclude_unset=True)
        return all(
            getattr(obligation, "expected_amount" if key == "amount" else key) == value
            for key, value in changes.items()
        )
    obligation = next(
        (o for o in twin.one_time_obligations if o.id == proposal.obligation_id), None
    )
    if obligation is None or proposal.one_time_changes is None:
        return False
    changes = proposal.one_time_changes.model_dump(exclude_unset=True)
    return all(getattr(obligation, k) == v for k, v in changes.items())


# --- Reading one message ------------------------------------------------------


def compose_reply(
    reading: Reading, duplicates: int, dropped: bool, model_fell_back: bool
) -> str:
    if reading.proposals and reading.questions:
        reply = REPLY_BOTH
    elif reading.proposals:
        reply = REPLY_PROPOSALS
    elif reading.questions:
        reply = REPLY_QUESTIONS
    elif reading.simulate_prefill is not None:
        reply = REPLY_WHAT_IF
    elif duplicates:
        reply = REPLY_DUPLICATE
    else:
        reply = REPLY_NOTHING
    if reading.simulate_prefill is not None and reply is not REPLY_WHAT_IF:
        reply = f"{reply} {REPLY_WHAT_IF}"
    if dropped:
        reply += OVER_FIVE_SUFFIX
    if model_fell_back:
        reply = MODEL_FALLBACK_PREFIX + reply
    return reply


def read_message(
    twin: FinancialTwin,
    text: str,
    extract: Callable[[str, date], LlmDraft | None] | None = None,
) -> Reading:
    """Read one message into drafts and questions. Nothing here writes (AS-1).

    `extract` is the seam the model path plugs into: passing one is how a test uses
    a fake, and leaving it None lets `compile_goals_auto` decide, which means the
    rules compiler unless the group lead turned a model on (AS-16).
    """
    clauses = split_clauses(text)
    proposals: list[Proposal] = []
    questions: list[AssistantQuestion] = []
    prefill: SimulatePrefill | None = None
    handled: list[str] = []

    for clause in clauses:
        found, field_name, question_text = read_what_if(clause, twin.as_of)
        if found is not None or question_text is not None:
            handled.append(clause)
            if found is not None and prefill is None:
                prefill = found
            if question_text is not None:
                questions.append(_ask(field_name, question_text, clause))
            continue
        proposal, question = read_update(clause, twin)
        if proposal is not None or question is not None:
            handled.append(clause)
            if proposal is not None:
                proposals.append(proposal)
            if question is not None:
                questions.append(question)

    # Whatever the Assistant did not claim goes to the compiler, whole and in order,
    # so a clause that leans on the one before it ("keep $1,500 for emergencies and
    # $300 in checking") is still read the way the compiler expects.
    remaining = [c for c in clauses if c not in handled]
    result = None
    if remaining:
        rest = text if len(remaining) == len(clauses) else " and ".join(remaining)
        kwargs = {"extract": extract} if extract is not None else {}
        result = compile_goals_auto(
            twin.user_id,
            rest,
            twin.as_of,
            accounts=twin.accounts,
            detected=twin.obligations,
            **kwargs,
        )
        proposals.extend(proposals_from(result, twin, remaining))
        questions.extend(
            _ask(c.field, c.question, c.fragment, choices_for(c.field, twin))
            for c in result.clarifications
        )

    kept = [p for p in proposals if not already_true(p, twin)]
    duplicates = len(proposals) - len(kept)
    dropped = len(kept) > MAX_PROPOSALS_PER_REPLY

    read_by = "model" if result is not None and result.compiler == "llm" else "rules"
    model_fell_back = llm_enabled() and read_by == "rules"

    reading = Reading(
        reply="",
        read_by=read_by,
        proposals=kept[:MAX_PROPOSALS_PER_REPLY],
        questions=questions[:MAX_QUESTIONS_PER_REPLY],
        simulate_prefill=prefill,
        unparsed=list(result.unparsed) if result is not None else [],
    )
    reading.reply = compose_reply(reading, duplicates, dropped, model_fell_back)
    return reading


# --- Accepting one (AS-15) ----------------------------------------------------


def apply_proposal(proposal: Proposal) -> FinancialTwin:
    """Apply an accepted proposal to the twin, re-checked against the twin as it is now.

    Every write goes through `twin_store`, the same way a manual edit does, so a
    proposal can never put something on the twin that a form could not.
    """
    twin = twin_store.get_twin()
    try:
        if proposal.action_type == "ADD_GOAL":
            goal = proposal.goal.model_copy(
                update={"id": unique_goal_id(proposal.goal.name, {g.id for g in twin.goals})}
            )
            return twin_store.set_goals([*twin.goals, goal], twin.constraints)

        if proposal.action_type == "UPDATE_GOAL":
            goals = list(twin.goals)
            index = next(
                (i for i, g in enumerate(goals) if g.id == proposal.goal_id), None
            )
            if index is None:
                raise NotApplicable(proposal.goal_id)
            goals[index] = goals[index].model_copy(
                update=proposal.changes.model_dump(exclude_unset=True)
            )
            return twin_store.set_goals(goals, twin.constraints)

        if proposal.action_type == "SET_CONSTRAINT":
            kept: list[FinancialConstraint] = [
                c for c in twin.constraints if c.type != proposal.constraint.type
            ]
            return twin_store.set_goals(twin.goals, [*kept, proposal.constraint])

        if proposal.action_type == "ADD_OBLIGATION":
            if proposal.obligation.account_id not in {a.id for a in twin.accounts}:
                raise NotApplicable(proposal.obligation.account_id)
            owed = proposal.obligation.model_copy(
                update={
                    "id": unique_obligation_id(
                        proposal.obligation.name, {o.id for o in twin.one_time_obligations}
                    )
                }
            )
            return twin_store.set_goals(
                twin.goals, twin.constraints, [*twin.one_time_obligations, owed]
            )

        if proposal.action_type == "UPDATE_OBLIGATION":
            if proposal.kind == "recurring":
                if proposal.recurring_changes is None:
                    raise NotApplicable(proposal.obligation_id)
                changes = proposal.recurring_changes.model_dump(exclude_unset=True)
                if "amount" in changes:
                    changes["expected_amount"] = changes.pop("amount")
                return twin_store.override_recurring(
                    proposal.obligation_id, twin_store.RecurringOverride(**changes)
                )
            owed = list(twin.one_time_obligations)
            index = next(
                (i for i, o in enumerate(owed) if o.id == proposal.obligation_id), None
            )
            if index is None or proposal.one_time_changes is None:
                raise NotApplicable(proposal.obligation_id)
            owed[index] = owed[index].model_copy(
                update=proposal.one_time_changes.model_dump(exclude_unset=True)
            )
            return twin_store.set_goals(twin.goals, twin.constraints, owed)

        return twin_store.declare_category(
            proposal.classification.obligation_id, proposal.classification.category
        )
    except (twin_store.InvalidDeclaration, twin_store.UnknownObligation) as e:
        raise NotApplicable(str(e)) from e
