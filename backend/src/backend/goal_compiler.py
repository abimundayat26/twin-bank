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

Amounts are read in the forms listed in `frontend/SPEC.md` 8.5: "$2,000", "2000",
"2000 dollars", "2k", "$2.5k", "two thousand", "fifteen hundred", "a grand", with a
leading "around"/"about"/"roughly"/"~" ignored. A bare number is money only once the
date and period readings are ruled out, so "due Jan 15" and "in 6 months" stay dates.
Anything else is not guessed.
"""

import calendar
import re
from collections.abc import Callable, Sequence
from datetime import date, timedelta

from backend.intent_router import (
    CHECKING_WORDS,
    FLOOR_WORDS,
    GOAL_WORDS,
    OBLIGATION_WORDS,
    RESERVE_WORDS,
    Routing,
    route_clause,
)
from backend.schemas import (
    Account,
    FinancialConstraint,
    FinancialObligation,
    Goal,
    GoalClarification,
    GoalCompileResponse,
    ObligationClassificationDraft,
    OneTimeObligation,
)
from backend.simulation.engine import MAX_HORIZON_DAYS

RESERVE_ID = "con_emergency_reserve"
# Same id as twin_store.MINIMUM_BALANCE_ID, so a confirmed draft replaces the saved answer.
CHECKING_FLOOR_ID = "con_minimum_checking"

MONTHS = {name.lower(): i for i, name in enumerate(calendar.month_name) if name}
MONTHS |= {name.lower(): i for i, name in enumerate(calendar.month_abbr) if name}
MONTH = r"(?P<month>" + "|".join(sorted(MONTHS, key=len, reverse=True)) + r")\.?"

NUMBER = r"\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?"
MONTH_NAMES = "|".join(sorted(MONTHS, key=len, reverse=True))

# What a scale word multiplies by. "k", "thousand" and "grand" are the same thousand
# (frontend/SPEC.md 8.5).
SCALES = {"k": 1000, "thousand": 1000, "grand": 1000, "hundred": 100}
SCALE = r"k|thousand|grand"

# Number words, for "two thousand", "fifteen hundred", "a grand". A scale word is
# required: "I want two laptops" names a count, not an amount.
ONES = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19,
}
TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90,
}
_ONES_ALT = "|".join(sorted(ONES, key=len, reverse=True))
_TENS_ALT = "|".join(sorted(TENS, key=len, reverse=True))
WORD_NUMBER = rf"(?:{_TENS_ALT})(?:[-\s](?:{_ONES_ALT}))?|{_ONES_ALT}|an|a"

# Four branches, tried in this order at each position:
#   1. "$2,000", "$2.5k"        -- a dollar sign leads
#   2. "2k", "1.2k", "2 grand", "2000 dollars" -- a scale or "dollars" follows
#   3. "two thousand", "fifteen hundred", "a grand" -- number words plus a scale
#   4. "2000", "1050", "300"    -- a bare number, which is only money once the
#      date-shaped and period-shaped readings are excluded. `mon` catches "Jan 15"
#      and "May 2027" by consuming the month name, so `iter_amounts` can drop the
#      whole match rather than mistake the day or the year for dollars.
AMOUNT = re.compile(
    rf"\$\s?(?P<a>{NUMBER})\s?(?P<ak>{SCALE})?\b"
    rf"|\b(?P<b>{NUMBER})\s?(?:(?P<bk>{SCALE})\b(?:\s?dollars)?|dollars\b)"
    rf"|\b(?P<w>{WORD_NUMBER})[-\s]+(?P<ws>hundred|thousand|grand)\b"
    rf"|(?P<mon>\b(?:{MONTH_NAMES})\.?\s+)?"
    rf"(?<![\d.,\-/$])\b(?P<c>{NUMBER})\b"
    rf"(?!\s?(?:{SCALE})\b)(?!\s?dollars\b)(?!(?:st|nd|rd|th)\b)"
    rf"(?!\s+(?:day|week|month|year)s?\b)(?![\d\-/:])(?!\s*%)"
    # "by Dec 12, 2027": the year belongs to the date, so swallow it with the rest.
    rf"(?(mon)(?:,?\s+\d{{4}})?)",
    re.IGNORECASE,
)

DEADLINE_WORD = r"(?:by|before|until|no later than)"
# "by 2027", "in 2030": a bare year after a timing word is a deadline, not dollars.
YEAR_AFTER_TIMING = re.compile(rf"\b(?:by|before|until|than|in|on|during)\s+$", re.I)
# "by next June" is the same date as "by June": next_occurrence already rolls past as_of,
# so the qualifier only has to stop the month patterns failing to match at all.
MONTH_QUALIFIER = r"(?:(?:next|this|coming)\s+)?"
DEADLINE_PATTERNS = [
    ("iso", re.compile(rf"\b{DEADLINE_WORD}\s+(?P<iso>\d{{4}}-\d{{2}}-\d{{2}})\b", re.I)),
    (
        "end_of_month",
        re.compile(
            rf"\b{DEADLINE_WORD}\s+(?:the\s+)?end\s+of\s+{MONTH_QUALIFIER}{MONTH}"
            rf"(?:\s+(?P<year>\d{{4}}))?\b",
            re.I,
        ),
    ),
    (
        "month_day",
        re.compile(
            rf"\b{DEADLINE_WORD}\s+{MONTH_QUALIFIER}{MONTH}\s+(?P<day>\d{{1,2}})(?:st|nd|rd|th)?\b"
            rf"(?:,?\s+(?P<year>\d{{4}}))?",
            re.I,
        ),
    ),
    (
        "day_month",
        re.compile(
            rf"\b{DEADLINE_WORD}\s+(?:the\s+)?(?P<day>\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?"
            rf"{MONTH_QUALIFIER}{MONTH}"
            rf"(?:,?\s+(?P<year>\d{{4}}))?",
            re.I,
        ),
    ),
    ("month", re.compile(rf"\b{DEADLINE_WORD}\s+{MONTH_QUALIFIER}{MONTH}(?:\s+(?P<year>\d{{4}}))?\b", re.I)),
    (
        "month_offset",
        re.compile(rf"\b{DEADLINE_WORD}\s+(?P<offset>next|this|coming)\s+month\b", re.I),
    ),
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

NAME = re.compile(
    rf"\bfor\s+(?P<phrase>(?:(?:a|an|the|my|some)\s+)?(?P<name>.+?))"
    rf"(?=\s+{DEADLINE_WORD}\b|\s+(?:in|within)\s+(?:\d+|a|an|one)\s|[,;]|$)",
    re.I,
)

# --- One-time obligations -----------------------------------------------------

# "due 2027-01-15", "due on the 15th of January", "on October 1": timing words the
# goal patterns do not know. Rewriting them to "by" reuses parse_deadline whole
# instead of growing a second date parser. "on" counts only when a date plainly
# follows, so "$200 on my credit card" is not read as timing.
DUE_WORDS = re.compile(
    r"\bdue(?:\s+(?:on|by))?\b"
    rf"|\bon\b(?=\s+(?:the\s+)?(?:\d|{MONTH_NAMES}))",
    re.I,
)

# Which account pays it. Matched on type, because that is all the user says.
FUNDING = re.compile(
    r"\b(?:from|out\s+of|using)\s+(?:my\s+|the\s+)?(?P<account>checking|savings)"
    r"(?:\s+account)?\b",
    re.I,
)

MANDATORY_STATUS = re.compile(
    r"\b(?:mandatory|required|non[- ]negotiable|must\s+be\s+paid|cannot\s+be\s+skipped)\b",
    re.I,
)
OPTIONAL_STATUS = re.compile(
    r"\b(?:optional|not\s+mandatory|may\s+be\s+skipped|can\s+be\s+skipped)\b",
    re.I,
)
STATUS_WORDS = re.compile(
    rf"(?:{MANDATORY_STATUS.pattern})|(?:{OPTIONAL_STATUS.pattern})",
    re.I,
)

# Filler in front of the thing itself: "I have to pay the dentist" -> "dentist".
LEAD_WORDS = frozenset(
    "i we my our a an the this that there is are was have has had need needs needed "
    "must should to owe owes owed pay pays paying paid get got also still of for".split()
)

# A period ends a sentence, except after a month abbreviation followed by a day ("by Jan. 15").
MONTH_ABBRS = "|".join(name.lower() for name in calendar.month_abbr if name)
CLAUSE_SPLIT = re.compile(
    rf"[;!?]+|(?<!\b(?:{MONTH_ABBRS}))\.(?=\s|$)|\.(?=\s*$|\s+[^\s\d])|\n+", re.IGNORECASE
)
AND_SPLIT = re.compile(r",?\s+(?:and|but|also|plus)\s+", re.I)


def word_number(words: str) -> int:
    """"fifteen" -> 15, "twenty five" -> 25, "a" -> 1. Words it does not know count 0."""
    total = 0
    for word in re.split(r"[-\s]+", words.lower()):
        if word in ("a", "an"):
            total += 1
        else:
            total += ONES.get(word, 0) + TENS.get(word, 0)
    return total


def parse_amount(match: re.Match[str]) -> float:
    """The dollars one AMOUNT match stands for (frontend/SPEC.md 8.5)."""
    if match.group("w"):
        return float(word_number(match.group("w")) * SCALES[match.group("ws").lower()])
    number = match.group("a") or match.group("b") or match.group("c")
    scale = match.group("ak") or match.group("bk")
    value = float(number.replace(",", ""))
    return value * SCALES[scale.lower()] if scale else value


def is_money(match: re.Match[str], text: str) -> bool:
    """False for a bare number that is really part of a date (AS-6).

    The regex cannot decide this alone: "Jan 15" and "by 2027" are both a number
    after a word, and only the words around them say which is dollars.
    """
    if match.group("mon"):  # "Jan 15", "May 2027": the month name was consumed
        return False
    if match.group("c") and 1900 <= float(match.group("c").replace(",", "")) <= 2100:
        if YEAR_AFTER_TIMING.search(text[: match.start()]):
            return False
    return True


def iter_amounts(text: str) -> list[re.Match[str]]:
    """Every amount of money in `text`, in the order it was written."""
    return [m for m in AMOUNT.finditer(text) if is_money(m, text)]


def strip_amounts(text: str, repl: str = "") -> str:
    """`text` with its amounts taken out, so what is left can be read as a name."""
    out, last = [], 0
    for match in iter_amounts(text):
        out.append(text[last : match.start()])
        out.append(repl)
        last = match.end()
    out.append(text[last:])
    return "".join(out)


def starts_with_amount(text: str) -> bool:
    """"$300 in checking" carries on the "keep" before it; "I have $300" does not."""
    return any(m.start() == 0 for m in iter_amounts(text))


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
    if kind == "month_offset":
        # "by next month", like "by June", means by the time that month starts. "by this
        # month" can only mean the end of the month we are already partway through.
        this_month = m.group("offset").lower() == "this"
        target = as_of if this_month else add_months(as_of, 1)
        day = calendar.monthrange(target.year, target.month)[1] if this_month else 1
        return date(target.year, target.month, day)
    month = MONTHS[m.group("month").lower()]
    year = int(m.group("year")) if m.group("year") else None
    day = -1 if kind == "end_of_month" else int(m.group("day")) if "day" in m.groupdict() else None
    return next_occurrence(as_of, month, day, year)


def split_clauses(text: str) -> list[str]:
    """Sentences, then "and"-joined parts. A part with no amount is kept with the one
    before it, so "$500 for books and supplies by January" stays one goal."""
    clauses = []
    for sentence in CLAUSE_SPLIT.split(text):
        parts = [p.strip(" ,\t\r\n") for p in AND_SPLIT.split(sentence) if p.strip(" ,\t\r\n")]
        merged: list[str] = []
        for part in parts:
            if merged and not iter_amounts(part) and not RESERVE_WORDS.search(part):
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
    name = strip_amounts(m.group("name")).strip(" ,.")
    if not name:
        return None
    return name[:1].upper() + name[1:], strip_amounts(m.group("phrase")).strip(" ,.")


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "goal"


def check_deadline(
    deadline: date | None, deadline_words: str | None, what: str, as_of: date
) -> str | None:
    """The clarification question to ask about a goal's deadline, or None if it is usable.

    what completes "When do you need the money ...?", e.g. "for a car".
    """
    if deadline is None:
        if deadline_words:
            return f'When exactly is "{deadline_words}"? Give a date.'
        return f"When do you need the money {what}?"
    if deadline <= as_of:
        return f"{deadline} has already passed. When do you need it {what}?"
    # PUT /twin/{user_id}/goals rejects anything later, so a draft never goes past it.
    latest_deadline = as_of + timedelta(days=MAX_HORIZON_DAYS)
    if deadline > latest_deadline:
        return (
            f"{deadline} is too far ahead to plan for; goals can be due by {latest_deadline} "
            f"at the latest. When do you need the money {what}?"
        )
    return None


def obligation_name(clause: str, deadline_words: str | None) -> str | None:
    """A short name for what is owed: "Tuition" from "$1,200 tuition due 2027-01-15".

    `clause` must already have its timing words rewritten to "by" by DUE_WORDS, so
    `deadline_words` is a substring of it.
    """
    named = goal_name(clause)
    if named:  # "I owe $300 for a parking ticket by Nov 1"
        return named[0]
    rest = clause.replace(deadline_words, " ", 1) if deadline_words else clause
    rest = STATUS_WORDS.sub(" ", strip_amounts(FUNDING.sub(" ", rest), " "))
    words = [w for w in rest.split() if w]
    while words and re.sub(r"[^a-z]", "", words[0].lower()) in LEAD_WORDS:
        words.pop(0)
    name = " ".join(words).strip(" ,.;:'\"")
    return name[:1].upper() + name[1:] if name else None


def funding_account(clause: str, accounts: Sequence[Account]) -> tuple[str | None, str | None]:
    """(account id, the question to ask instead). Exactly one of the two is set.

    Named accounts are matched on type, which is all the user says. With nothing
    named, the compiler asks even when only one account exists: funding is a required
    declaration, not something banking data can supply on the user's behalf.
    """
    match = FUNDING.search(clause)
    if match:
        wanted = match.group("account").lower()
        same = [a for a in accounts if a.type == wanted]
        if len(same) == 1:
            return same[0].id, None
        if not same:
            return None, f"There is no {wanted} account on file. Which account pays this?"
        listed = " or ".join(a.name for a in same)
        return None, f"Which {wanted} account pays this, {listed}?"
    if not accounts:
        return None, "Which account is this paid from?"
    listed = ", ".join(a.name for a in accounts)
    return None, f"Which account is this paid from? You have {listed}."


def obligation_status(clause: str) -> bool | None:
    """Return the status the user stated, or None when it is absent or contradictory."""
    mandatory = bool(MANDATORY_STATUS.search(clause))
    optional = bool(OPTIONAL_STATUS.search(clause))
    if mandatory == optional:
        return None
    return mandatory


def check_due_date(due: date | None, due_words: str | None, what: str, as_of: date) -> str | None:
    """The question to ask about a one-time obligation's due date, or None if it is usable.

    Unlike a goal deadline this has no horizon limit: a commitment two years out is
    still a real commitment, it simply falls outside what the simulator projects.
    """
    if due is None:
        if due_words:
            return f'When exactly is "{due_words}"? Give a date.'
        return f"When is {what} due?"
    if due <= as_of:
        return f"{due} has already passed. When is {what} due?"
    return None


def unique_obligation_id(name: str, taken: set[str]) -> str:
    """one_<slug>, with _2, _3, ... added when that id is already taken."""
    obligation_id = f"one_{slug(name)}"
    suffix = 2
    while obligation_id in taken:
        obligation_id = f"one_{slug(name)}_{suffix}"
        suffix += 1
    return obligation_id


def unique_goal_id(name: str, taken: set[str]) -> str:
    """goal_<slug>, with _2, _3, ... added when that id is already taken."""
    goal_id = f"goal_{slug(name)}"
    suffix = 2
    while goal_id in taken:
        goal_id = f"goal_{slug(name)}_{suffix}"
        suffix += 1
    return goal_id


def dedupe_constraints(
    constraints: list[FinancialConstraint],
    text: str,
    ask: Callable[[str, str, str], None],
) -> list[FinancialConstraint]:
    """Drop every constraint of a type given more than once, and ask which amount was meant."""
    for constraint_type in ("minimum_reserve", "minimum_checking_balance"):
        same = [c for c in constraints if c.type == constraint_type]
        if len(same) > 1:
            constraints = [c for c in constraints if c.type != constraint_type]
            listed = " and ".join(money(c.amount) for c in same)
            ask("amount", f"You gave two amounts to keep ({listed}). Which one?", text)
    return constraints


def draft_classification(
    routed: Routing,
    detected: Sequence[FinancialObligation],
    drafted: list[ObligationClassificationDraft],
) -> None:
    """Read the user's answer back for confirmation. Nothing is declared here.

    The id can only have come from `detected`, so there is no path by which an answer
    about an obligation the twin does not have reaches the twin.
    """
    obligation = next((o for o in detected if o.id == routed.obligation_id), None)
    if obligation is None or routed.category is None:
        return
    drafted.append(
        ObligationClassificationDraft(
            obligation_id=obligation.id,
            obligation_name=obligation.name,
            category=routed.category,
            fragment=routed.fragment,
        )
    )


def draft_obligation(
    clause: str,
    as_of: date,
    accounts: Sequence[Account],
    drafted: list[OneTimeObligation],
    ask: Callable[[str, str, str], None],
) -> None:
    """Draft one one-time obligation from a clause, or ask for every part that is missing.

    A missing part means nothing is drafted: an obligation reaches the twin only once
    the user has confirmed a complete draft (frontend/SPEC.md 3.2).
    """
    normalized = DUE_WORDS.sub("by", clause)
    amounts = [parse_amount(m) for m in iter_amounts(normalized)]
    name = obligation_name(normalized, parse_deadline(normalized, as_of)[1])
    what = f"the {name.lower()}" if name else "this"
    missing = False

    if not amounts:
        ask("amount", f"How much is {what}?", clause)
        missing = True
    if name is None:
        ask("name", f"What is {money(amounts[0]) if amounts else 'this'} for?", clause)
        missing = True

    due, due_words = parse_deadline(normalized, as_of)
    question = check_due_date(due, due_words, what, as_of)
    if question:
        ask("deadline", question, clause)
        missing = True

    account_id, account_question = funding_account(normalized, accounts)
    if account_question:
        ask("account", account_question, clause)
        missing = True

    mandatory = obligation_status(clause)
    if mandatory is None:
        ask("mandatory", f"Is {what} mandatory or optional?", clause)
        missing = True

    if missing:
        return
    assert name is not None and due is not None and account_id is not None and mandatory is not None
    drafted.append(
        OneTimeObligation(
            id=unique_obligation_id(name, {o.id for o in drafted}),
            name=name,
            amount=amounts[0],
            due_date=due,
            account_id=account_id,
            mandatory=mandatory,
        )
    )


def compile_goals(
    user_id: str,
    text: str,
    as_of: date,
    accounts: Sequence[Account] = (),
    detected: Sequence[FinancialObligation] = (),
) -> GoalCompileResponse:
    """Drafts only.

    `accounts` are the twin's, used to resolve which one pays an obligation.
    `detected` are its recurring obligations, so an answer about one is recognised as
    an answer rather than mistaken for a new declaration.
    """
    goals: list[Goal] = []
    constraints: list[FinancialConstraint] = []
    obligations: list[OneTimeObligation] = []
    classifications: list[ObligationClassificationDraft] = []
    clarifications: list[GoalClarification] = []
    unparsed: list[str] = []
    previous_is_floor = False

    def ask(field, question: str, fragment: str) -> None:
        clarifications.append(GoalClarification(field=field, question=question, fragment=fragment))

    for clause in split_clauses(text):
        amounts = [parse_amount(m) for m in iter_amounts(clause)]
        is_reserve = bool(RESERVE_WORDS.search(clause))
        # "keep $1,500 for emergencies and $300 in checking": a part that is just an
        # amount carries on the "keep" before it. "I have $300 in checking" does not.
        continues_floor = (
            previous_is_floor
            and starts_with_amount(clause)
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

        # Constraints are settled above, so by here the only readings left are a goal,
        # an expense already owed, or an answer about an obligation already detected.
        # Which of those it is belongs to one place: backend.intent_router.
        routed = route_clause(clause, detected)
        if routed.intent == "ambiguous":
            ask("intent", routed.question or "What kind of thing is this?", clause)
            continue
        if routed.intent == "obligation_classification":
            draft_classification(routed, detected, classifications)
            continue
        if routed.intent == "one_time_obligation":
            draft_obligation(clause, as_of, accounts, obligations, ask)
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
        deadline_question = check_deadline(deadline, deadline_words, what, as_of)
        if deadline_question:
            ask("deadline", deadline_question, clause)
            missing = True
        if missing:
            continue

        assert name is not None and deadline is not None
        goal_id = unique_goal_id(name, {g.id for g in goals})
        goals.append(Goal(id=goal_id, name=name, target_amount=amounts[0], deadline=deadline))

    constraints = dedupe_constraints(constraints, text, ask)

    return GoalCompileResponse(
        user_id=user_id,
        text=text,
        goals=goals,
        constraints=constraints,
        one_time_obligations=obligations,
        classifications=classifications,
        clarifications=clarifications,
        unparsed=unparsed,
        compiler="rules",
    )
