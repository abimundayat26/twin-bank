"""User answers layered on top of whichever twin is configured.

Answers (declared obligation categories, the minimum checking balance,
confirmed goals, the emergency reserve and confirmed one-time obligations) live
in process memory and are saved to
a small JSON file, so they survive a server restart. `TWIN_ANSWERS_PATH` moves
the file; set it empty to keep answers in memory only. Delete the file to start
over. A missing, unreadable or unwritable file is logged and never fails a
request. Where the twin underneath the answers comes from -- the fixture or
Nessie -- is `twin_source`'s decision, not this module's. Nothing here
calculates money.
"""

import logging
import os
from datetime import timedelta
from pathlib import Path

from pydantic import BaseModel, ValidationError

from backend.schemas import (
    FinancialConstraint,
    FinancialTwin,
    Goal,
    ObligationCategory,
    OneTimeObligation,
)
from backend.simulation.engine import MAX_HORIZON_DAYS
from backend.twin_source import load_source_twin

logger = logging.getLogger(__name__)

MINIMUM_BALANCE_ID = "con_minimum_checking"
DEFAULT_ANSWERS_PATH = Path(__file__).resolve().parents[2] / ".data" / "answers.json"


def _answers_path_from_env() -> Path | None:
    value = os.getenv("TWIN_ANSWERS_PATH")
    if value is None:
        return DEFAULT_ANSWERS_PATH
    return Path(value) if value.strip() else None


answers_path: Path | None = _answers_path_from_env()
_loaded = False

declared_categories: dict[str, ObligationCategory] = {}  # obligation id -> answer
minimum_checking_balance: float | None = None
# None means "not answered yet": the fixture's goals and reserve apply.
declared_goals: list[Goal] | None = None
declared_reserves: list[FinancialConstraint] | None = None
# Declared, so they belong here rather than on the built twin: a rebuild from
# transactions can neither invent one nor wipe one it never knew about.
declared_one_time_obligations: list[OneTimeObligation] | None = None


class UnknownObligation(KeyError):
    pass


class InvalidDeclaration(ValueError):
    pass


class _SavedAnswers(BaseModel):
    """The answers file. Private to this module, not a shared contract."""

    declared_categories: dict[str, ObligationCategory] = {}
    minimum_checking_balance: float | None = None
    declared_goals: list[Goal] | None = None
    declared_reserves: list[FinancialConstraint] | None = None
    declared_one_time_obligations: list[OneTimeObligation] | None = None


def _load() -> None:
    """Read saved answers once per process. Any problem means no saved answers."""
    global _loaded, minimum_checking_balance, declared_goals, declared_reserves
    global declared_one_time_obligations
    if _loaded:
        return
    _loaded = True
    if answers_path is None or not answers_path.exists():
        return
    try:
        saved = _SavedAnswers.model_validate_json(answers_path.read_text())
    except (OSError, ValidationError) as e:
        logger.warning("Ignoring saved answers in %s: %s", answers_path, e)
        return
    declared_categories.clear()
    declared_categories.update(saved.declared_categories)
    minimum_checking_balance = saved.minimum_checking_balance
    declared_goals = saved.declared_goals
    declared_reserves = saved.declared_reserves
    declared_one_time_obligations = saved.declared_one_time_obligations


def _save() -> None:
    if answers_path is None:
        return
    saved = _SavedAnswers(
        declared_categories=declared_categories,
        minimum_checking_balance=minimum_checking_balance,
        declared_goals=declared_goals,
        declared_reserves=declared_reserves,
        declared_one_time_obligations=declared_one_time_obligations,
    )
    tmp = answers_path.with_name(answers_path.name + ".tmp")
    try:
        answers_path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(saved.model_dump_json(indent=2))
        os.replace(tmp, answers_path)
    except OSError as e:
        # The answer still applies for this process; only the restart copy is lost.
        logger.warning("Could not save answers to %s: %s", answers_path, e)


def get_twin() -> FinancialTwin:
    """The twin from whichever source is configured, with the user's answers applied."""
    _load()
    twin = load_source_twin()
    obligations = [
        o.model_copy(update={"declared_category": declared_categories[o.id]})
        if o.id in declared_categories
        else o
        for o in twin.obligations
    ]
    reserves = [c for c in twin.constraints if c.type == "minimum_reserve"]
    constraints = declared_reserves if declared_reserves is not None else reserves
    constraints = [c for c in constraints if c.type != "minimum_checking_balance"]
    if minimum_checking_balance is not None:
        constraints.append(
            FinancialConstraint(
                id=MINIMUM_BALANCE_ID,
                type="minimum_checking_balance",
                amount=minimum_checking_balance,
                description=f"Keep at least ${minimum_checking_balance:,.0f} in checking.",
            )
        )
    goals = declared_goals if declared_goals is not None else twin.goals
    # Never dropped when the account they name has gone: the money is still owed, and
    # the simulator falls back to checking. Silently deleting a commitment would
    # flatter the forecast, which is the one thing a financial twin must not do.
    owed = (
        declared_one_time_obligations
        if declared_one_time_obligations is not None
        else twin.one_time_obligations
    )
    return twin.model_copy(
        update={
            "obligations": obligations,
            "constraints": constraints,
            "goals": goals,
            "one_time_obligations": owed,
        }
    )


def declare_category(obligation_id: str, category: ObligationCategory) -> FinancialTwin:
    if obligation_id not in {o.id for o in get_twin().obligations}:
        raise UnknownObligation(obligation_id)
    declared_categories[obligation_id] = category
    _save()
    return get_twin()


def set_minimum_checking_balance(amount: float) -> FinancialTwin:
    global minimum_checking_balance
    _load()
    minimum_checking_balance = amount
    _save()
    return get_twin()


def check_one_time_obligations(
    owed: list[OneTimeObligation], twin: FinancialTwin
) -> None:
    """Every confirmed obligation must be payable from an account the twin has.

    Checked here rather than in the model, so an older payload whose account has since
    been deleted still parses. The spec does not define this case; reporting it at the
    moment of declaration is the only point at which the user can fix it.
    """
    if len({o.id for o in owed}) != len(owed):
        raise InvalidDeclaration("One-time obligation ids must be unique")
    account_ids = {a.id for a in twin.accounts}
    for obligation in owed:
        if obligation.account_id not in account_ids:
            raise InvalidDeclaration(
                f"One-time obligation '{obligation.id}' is paid from account "
                f"'{obligation.account_id}', which does not exist"
            )
        if obligation.due_date <= twin.as_of:
            raise InvalidDeclaration(
                f"One-time obligation '{obligation.id}' is due {obligation.due_date}, "
                f"which is not after {twin.as_of}"
            )


def set_goals(
    goals: list[Goal],
    constraints: list[FinancialConstraint],
    one_time_obligations: list[OneTimeObligation] | None = None,
) -> FinancialTwin:
    """Replace the goals and emergency reserve. A checking minimum in constraints is
    saved as the minimum checking balance; leaving it out keeps the current one.

    `one_time_obligations` left as None keeps the ones already confirmed; an empty
    list clears them. They are never derived from anything, only confirmed.
    """
    global declared_goals, declared_reserves, declared_one_time_obligations
    current = get_twin()
    as_of = current.as_of
    latest = as_of + timedelta(days=MAX_HORIZON_DAYS)
    if len({g.id for g in goals}) != len(goals):
        raise InvalidDeclaration("Goal ids must be unique")
    for goal in goals:
        if not as_of < goal.deadline <= latest:
            raise InvalidDeclaration(
                f"Goal '{goal.id}' deadline {goal.deadline} must be after {as_of} and no later than {latest}"
            )
    for constraint_type in ("minimum_reserve", "minimum_checking_balance"):
        if sum(c.type == constraint_type for c in constraints) > 1:
            raise InvalidDeclaration(f"At most one {constraint_type} constraint")
    if one_time_obligations is not None:
        check_one_time_obligations(one_time_obligations, current)
    floor = next((c for c in constraints if c.type == "minimum_checking_balance"), None)
    if one_time_obligations is not None:
        declared_one_time_obligations = list(one_time_obligations)
    declared_goals = list(goals)
    declared_reserves = [c for c in constraints if c.type == "minimum_reserve"]
    if floor is not None:
        set_minimum_checking_balance(floor.amount)
    else:
        _save()
    return get_twin()


def reset() -> None:
    """Forget answers in memory. The saved file is left alone and not re-read."""
    global minimum_checking_balance, declared_goals, declared_reserves, _loaded
    global declared_one_time_obligations
    _loaded = True
    declared_categories.clear()
    minimum_checking_balance = None
    declared_goals = None
    declared_reserves = None
    declared_one_time_obligations = None
