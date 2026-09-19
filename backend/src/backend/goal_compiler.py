"""Rule-based goal compiler: turn what the user wrote into draft goals and constraints.

Nothing is inferred beyond the words themselves (SPEC section 2). When a goal is
missing its amount, deadline or name, or an amount could mean two things, the
compiler asks a clarification question instead of filling in a default. Parts of
the text that match no rule are handed back as unparsed. The output is a draft:
nothing is saved until the user confirms it with PUT /twin/{user_id}/goals.

Rules, per clause:
- "keep at least $1,500 for emergencies" -> minimum_reserve (checking plus savings).
- "keep at least $300 in checking" -> minimum_checking_balance. So does "keep $1,500
  for emergencies and $300 in checking": a part that starts with its amount
  carries on the "keep" before it.
- "$2,000 for summer housing by May" -> a goal. Deadlines: "by May" (the 1st of
  the next May after as_of), "by May 15", "by end of May", "by May 2027",
  "by 2027-05-01", "in 6 months" / "in 3 weeks" / "in 1 year". A deadline more
  than MAX_HORIZON_DAYS after as_of, or one that is not a real date, is asked about.
- Reserve words with a deadline, or without "keep"-style words ("save $3,000 for an
  emergency fund by December"), ask whether it is a goal or a reserve.
"""

import calendar
import re
from datetime import date, timedelta

from backend.schemas import FinancialConstraint, Goal, GoalClarification, GoalCompileResponse
from backend.simulation.engine import MAX_HORIZON_DAYS

RESERVE_ID = "con_emergency_reserve"
# Same id as twin_store.MINIMUM_BALANCE_ID, so a confirmed draft replaces the saved answer.
CHECKING_FLOOR_ID = "con_minimum_checking"

MONTHS = {name.lower(): i for i, name in enumerate(calendar.month_name) if name}
MONTHS |= {name.lower(): i for i, name in enumerate(calendar.month_abbr) if name}
MONTH = r"(?P<month>" + "|".join(sorted(MONTHS, key=len, reverse=True)) + r")\.?"

NUMBER = r"\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?"
AMOUNT = re.compile(
    rf"\$\s?(?P<a>{NUMBER})\s?(?P<ak>k|thousand)?\b"
    rf"|\b(?P<b>{NUMBER})\s?(?:(?P<bk>k|thousand)\b(?:\s?dollars)?|dollars\b)",
    re.IGNORECASE,
)

DEADLINE_WORD = r"(?:by|before|until|no later than)"
DEADLINE_PATTERNS = [
    ("iso", re.compile(rf"\b{DEADLINE_WORD}\s+(?P<iso>\d{{4}}-\d{{2}}-\d{{2}})\b", re.I)),
    (
        "end_of_month",
        re.compile(rf"\b{DEADLINE_WORD}\s+(?:the\s+)?end\s+of\s+{MONTH}(?:\s+(?P<year>\d{{4}}))?\b", re.I),
    ),
    (
        "month_day",
        re.compile(
            rf"\b{DEADLINE_WORD}\s+{MONTH}\s+(?P<day>\d{{1,2}})(?:st|nd|rd|th)?\b(?:,?\s+(?P<year>\d{{4}}))?",
            re.I,
        ),
    ),
    (
        "day_month",
        re.compile(
            rf"\b{DEADLINE_WORD}\s+(?:the\s+)?(?P<day>\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?{MONTH}"
            rf"(?:,?\s+(?P<year>\d{{4}}))?",
            re.I,
        ),
    ),
    ("month", re.compile(rf"\b{DEADLINE_WORD}\s+{MONTH}(?:\s+(?P<year>\d{{4}}))?\b", re.I)),
    (
        "relative",
        re.compile(r"\b(?:in|within)\s+(?P<n>\d+|a|an|one)\s+(?P<unit>week|month|year)s?\b", re.I),
    ),
]
# Deadline-sounding words the rules cannot turn into a date ("by summer", "soon").
VAGUE_DEADLINE = re.compile(
    rf"\b{DEADLINE_WORD}\s+(?:the\s+)?(?:next\s+)?(?:summer|spring|fall|autumn|winter|graduation)\b"
    r"|\b(?:soon|someday|eventually|next\s+(?:summer|spring|fall|autumn|winter|year|semester))\b",
    re.I,
)

RESERVE_WORDS = re.compile(r"\b(?:emergenc(?:y|ies)|reserve|rainy[- ]day|safety net|cushion)\b", re.I)
CHECKING_WORDS = re.compile(r"\bchecking\b", re.I)
FLOOR_WORDS = re.compile(
    r"\b(?:keep|at least|minimum|never\s+(?:drop|go|fall|dip)|below|under|leave)\b", re.I
)
GOAL_WORDS = re.compile(r"\b(?:need|save|saving|want|goal|fund|put aside|set aside)\b", re.I)
NAME = re.compile(
    rf"\bfor\s+(?P<phrase>(?:(?:a|an|the|my|some)\s+)?(?P<name>.+?))"
    rf"(?=\s+{DEADLINE_WORD}\b|\s+(?:in|within)\s+(?:\d+|a|an|one)\s|[,;]|$)",
    re.I,
)

# A period ends a sentence, except after a month abbreviation followed by a day ("by Jan. 15").
MONTH_ABBRS = "|".join(name.lower() for name in calendar.month_abbr if name)
CLAUSE_SPLIT = re.compile(
    rf"[;!?]+|(?<!\b(?:{MONTH_ABBRS}))\.(?=\s|$)|\.(?=\s*$|\s+[^\s\d])|\n+", re.IGNORECASE
)
AND_SPLIT = re.compile(r",?\s+(?:and|but|also|plus)\s+", re.I)


def parse_amount(match: re.Match[str]) -> float:
    number = match.group("a") or match.group("b")
    thousands = match.group("ak") or match.group("bk")
    value = float(number.replace(",", ""))
    return value * 1000 if thousands else value


def money(amount: float) -> str:
    return f"${amount:,.0f}" if amount == int(amount) else f"${amount:,.2f}"


def add_months(start: date, months: int) -> date:
    month_index = start.month - 1 + months
    year, month = start.year + month_index // 12, month_index % 12 + 1
    return date(year, month, min(start.day, calendar.monthrange(year, month)[1]))


def next_occurrence(as_of: date, month: int, day: int | None, year: int | None) -> date | None:
    """The first matching date after as_of. day=None means the 1st; day=-1 the month's last day.

    None when the date does not exist (February 30) or an explicit year puts it in the past.
    """
    def build(y: int) -> date | None:
        last = calendar.monthrange(y, month)[1]
        d = 1 if day is None else last if day == -1 else day
        return date(y, month, d) if 1 <= d <= last else None

    if year is not None:
        return build(year)
    for y in (as_of.year, as_of.year + 1):
        candidate = build(y)
        if candidate is None:
            return None
        if candidate > as_of:
            return candidate
    return None


def parse_deadline(clause: str, as_of: date) -> tuple[date | None, str | None]:
    """(deadline, the matched words). (None, words) means words were found but are not a usable date."""
    for kind, pattern in DEADLINE_PATTERNS:
        m = pattern.search(clause)
        if not m:
            continue
        words = m.group(0)
        try:
            return deadline_from_match(kind, m, as_of), words
        except (ValueError, OverflowError):  # year 0, "in 99999 years", 2027-02-30
            return None, words
    vague = VAGUE_DEADLINE.search(clause)
    return None, vague.group(0) if vague else None


def deadline_from_match(kind: str, m: re.Match[str], as_of: date) -> date | None:
    if kind == "iso":
        return date.fromisoformat(m.group("iso"))
    if kind == "relative":
        n = 1 if m.group("n").lower() in ("a", "an", "one") else int(m.group("n"))
        unit = m.group("unit").lower()
        if unit == "week":
            return as_of + timedelta(weeks=n)
        return add_months(as_of, n * (12 if unit == "year" else 1))
    month = MONTHS[m.group("month").lower()]
    year = int(m.group("year")) if m.group("year") else None
    day = -1 if kind == "end_of_month" else int(m.group("day")) if "day" in m.groupdict() else None
    return next_occurrence(as_of, month, day, year)


def split_clauses(text: str) -> list[str]:
    """Sentences, then "and"-joined parts. A part with no amount is kept with the one
    before it, so "$500 for books and supplies by January" stays one goal."""
    clauses = []
    for sentence in CLAUSE_SPLIT.split(text):
        parts = [p.strip(" ,") for p in AND_SPLIT.split(sentence) if p.strip(" ,")]
        merged: list[str] = []
        for part in parts:
            if merged and not AMOUNT.search(part) and not RESERVE_WORDS.search(part):
                merged[-1] = f"{merged[-1]} and {part}"
            else:
                merged.append(part)
        clauses.extend(merged)
    return clauses


def goal_name(clause: str) -> tuple[str, str] | None:
    """(name, the words after "for"): ("Car", "a car")."""
    m = NAME.search(clause)
    if not m:
        return None
    name = AMOUNT.sub("", m.group("name")).strip(" ,.")
    if not name:
        return None
    return name[:1].upper() + name[1:], AMOUNT.sub("", m.group("phrase")).strip(" ,.")


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "goal"


def compile_goals(user_id: str, text: str, as_of: date) -> GoalCompileResponse:
    goals: list[Goal] = []
    constraints: list[FinancialConstraint] = []
    clarifications: list[GoalClarification] = []
    unparsed: list[str] = []
    previous_is_floor = False

    def ask(field, question: str, fragment: str) -> None:
        clarifications.append(GoalClarification(field=field, question=question, fragment=fragment))

    # PUT /twin/{user_id}/goals rejects anything later, so a draft never goes past it.
    latest_deadline = as_of + timedelta(days=MAX_HORIZON_DAYS)

    for clause in split_clauses(text):
        amounts = [parse_amount(m) for m in AMOUNT.finditer(clause)]
        is_reserve = bool(RESERVE_WORDS.search(clause))
        # "keep $1,500 for emergencies and $300 in checking": a part that is just an
        # amount carries on the "keep" before it. "I have $300 in checking" does not.
        continues_floor = (
            previous_is_floor
            and bool(AMOUNT.match(clause))
            and not GOAL_WORDS.search(clause)
        )
        has_floor = bool(FLOOR_WORDS.search(clause)) or continues_floor
        previous_is_floor = has_floor
        is_checking = bool(CHECKING_WORDS.search(clause)) and has_floor

        if any(a <= 0 for a in amounts):
            ask("amount", "An amount here is zero. How much do you mean?", clause)
            continue

        if len(amounts) > 1:
            listed = " and ".join(money(a) for a in amounts)
            ask("amount", f"This mentions {listed}. Which amount do you mean?", clause)
            continue

        if is_reserve or is_checking:
            if is_reserve and is_checking:
                ask(
                    "type",
                    "Should this be an emergency reserve across checking and savings, "
                    "or a minimum balance in checking alone?",
                    clause,
                )
            elif is_reserve and (parse_deadline(clause, as_of)[1] or not has_floor):
                # "save $3,000 for an emergency fund by December" or "reserve $200 for
                # tickets by October 30": could be a goal as much as a standing reserve.
                amount = f"{money(amounts[0])} " if amounts else ""
                ask(
                    "type",
                    f"Is this {amount}a savings goal with a deadline, or an emergency reserve "
                    "to keep across checking and savings at all times?",
                    clause,
                )
            elif not amounts:
                ask("amount", "How much do you want to keep?", clause)
            elif is_reserve:
                constraints.append(
                    FinancialConstraint(
                        id=RESERVE_ID,
                        type="minimum_reserve",
                        amount=amounts[0],
                        description=f"Keep at least {money(amounts[0])} across checking and "
                        "savings for emergencies.",
                    )
                )
            else:
                constraints.append(
                    FinancialConstraint(
                        id=CHECKING_FLOOR_ID,
                        type="minimum_checking_balance",
                        amount=amounts[0],
                        description=f"Keep at least {money(amounts[0])} in checking.",
                    )
                )
            continue

        if amounts and FLOOR_WORDS.search(clause) and not NAME.search(clause):
            ask(
                "type",
                f"Should {money(amounts[0])} be an emergency reserve across checking and savings, "
                "or a minimum balance in checking alone?",
                clause,
            )
            continue

        named = goal_name(clause)
        deadline, deadline_words = parse_deadline(clause, as_of)
        # Only words that ask for money make a goal: "I have $500" is not one.
        if not GOAL_WORDS.search(clause) and not (amounts and (named or deadline_words)):
            unparsed.append(clause)
            continue

        name, phrase = named if named else (None, None)
        what = f"for {phrase}" if phrase else "for this"
        missing = False
        if not amounts:
            ask("amount", f"How much do you need {what}?", clause)
            missing = True
        if name is None:
            ask("name", f"What is {money(amounts[0]) if amounts else 'this'} for?", clause)
            missing = True
        if deadline is None:
            if deadline_words:
                question = f'When exactly is "{deadline_words}"? Give a date.'
            else:
                question = f"When do you need the money {what}?"
            ask("deadline", question, clause)
            missing = True
        elif deadline <= as_of:
            ask("deadline", f"{deadline} has already passed. When do you need it {what}?", clause)
            missing = True
        elif deadline > latest_deadline:
            ask(
                "deadline",
                f"{deadline} is too far ahead to plan for; goals can be due by {latest_deadline} "
                f"at the latest. When do you need the money {what}?",
                clause,
            )
            missing = True
        if missing:
            continue

        assert name is not None and deadline is not None
        goal_id = f"goal_{slug(name)}"
        taken = {g.id for g in goals}
        suffix = 2
        while goal_id in taken:
            goal_id = f"goal_{slug(name)}_{suffix}"
            suffix += 1
        goals.append(Goal(id=goal_id, name=name, target_amount=amounts[0], deadline=deadline))

    for constraint_type in ("minimum_reserve", "minimum_checking_balance"):
        same = [c for c in constraints if c.type == constraint_type]
        if len(same) > 1:
            constraints = [c for c in constraints if c.type != constraint_type]
            listed = " and ".join(money(c.amount) for c in same)
            ask("amount", f"You gave two amounts to keep ({listed}). Which one?", text)

    return GoalCompileResponse(
        user_id=user_id,
        text=text,
        goals=goals,
        constraints=constraints,
        clarifications=clarifications,
        unparsed=unparsed,
        compiler="rules",
    )
