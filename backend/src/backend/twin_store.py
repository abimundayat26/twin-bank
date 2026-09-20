"""User answers layered on top of whichever twin is configured.

Answers (declared obligation categories, edits to detected recurring
obligations, the minimum checking balance, confirmed goals, the emergency
reserve and confirmed one-time obligations) live
in process memory and are saved to
a small JSON file, so they survive a server restart. `TWIN_ANSWERS_PATH` moves
the file; set it empty to keep answers in memory only. Delete the file to start
over. A missing, unreadable or unwritable file is logged and never fails a
request. Where the twin underneath the answers comes from -- the fixture or
Nessie -- is `twin_source`'s decision, not this module's. Nothing here
calculates money.
"""

import hashlib
import logging
import os
import re
import threading
from datetime import date, timedelta
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from backend.schemas import (
    EditableName,
    FinancialConstraint,
    FinancialObligation,
    FinancialTwin,
    Goal,
    GoalDateChange,
    MAX_MONEY,
    ObligationCategory,
    OneTimeObligation,
    OneTimeObligationChanges,
    OneTimeObligationCreate,
    RecurringObligationCreate,
    SimulationEvent,
)
from backend.simulation.engine import MAX_HORIZON_DAYS
from backend.twin_source import load_source_twin

logger = logging.getLogger(__name__)

# Every write goes through this (PER-7), so a commit that moves a goal and adds a
# purchase is never half-applied when two requests arrive together.
_write_lock = threading.RLock()

MINIMUM_BALANCE_ID = "con_minimum_checking"
DEFAULT_ANSWERS_PATH = Path(__file__).resolve().parents[2] / ".data" / "answers.json"


def _answers_path_from_env() -> Path | None:
    value = os.getenv("TWIN_ANSWERS_PATH")
    if value is None:
        return DEFAULT_ANSWERS_PATH
    return Path(value) if value.strip() else None


class RecurringOverride(BaseModel):
    """The user's edits to one detected recurring obligation, applied by id.

    Private to this module, not a shared contract: the route body that carries these
    edits is its own model in `schemas.py`. Only the fields the user actually changed
    are set; `None` means "leave the detector's value alone", which is why a paused
    obligation and one whose amount was corrected are told apart here rather than by
    comparing against the detector's output.

    The value ranges are repeated from the route body on purpose. Nothing invalid
    should be able to reach the answers file even if a future caller forgets to
    validate first.
    """

    name: EditableName | None = None
    expected_amount: float | None = Field(
        default=None, gt=0, le=MAX_MONEY, allow_inf_nan=False
    )
    due_day: int | None = Field(default=None, ge=1, le=31)
    active: bool | None = None


# Editing one of these makes the obligation the user's figure rather than the
# detector's (PER-5). Pausing is not on the list: a paused rent is still the rent
# that was observed, so its provenance does not change.
OVERRIDDEN_VALUES = ("name", "expected_amount", "due_day")

answers_path: Path | None = _answers_path_from_env()
_loaded = False
# Every write goes through one lock-protected function, so two requests cannot
# interleave a half-applied change into memory or the file (PER-7).
_write_lock = threading.Lock()

declared_categories: dict[str, ObligationCategory] = {}  # obligation id -> answer
# Recurring obligations are rebuilt from transactions, so an edit cannot live on the
# built twin: the next rebuild would silently undo it. It lives here instead, keyed
# by obligation id.
recurring_overrides: dict[str, RecurringOverride] = {}
# Recurring payments the user added cannot be rediscovered reliably from transaction
# history. Keep them beside the overrides so a rebuild cannot erase them (PER-1).
declared_recurring: list[FinancialObligation] = []
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


class DetectedObligationCannotBeDeleted(ValueError):
    pass


class _SavedAnswers(BaseModel):
    """The answers file. Private to this module, not a shared contract."""

    declared_categories: dict[str, ObligationCategory] = Field(default_factory=dict)
    # Defaults to empty, so an answers.json written before overrides existed still loads.
    recurring_overrides: dict[str, RecurringOverride] = Field(default_factory=dict)
    declared_recurring: list[FinancialObligation] = Field(default_factory=list)
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
    recurring_overrides.clear()
    recurring_overrides.update(saved.recurring_overrides)
    declared_recurring.clear()
    declared_recurring.extend(saved.declared_recurring)
    minimum_checking_balance = saved.minimum_checking_balance
    declared_goals = saved.declared_goals
    declared_reserves = saved.declared_reserves
    declared_one_time_obligations = saved.declared_one_time_obligations


def _save() -> None:
    if answers_path is None:
        return
    saved = _SavedAnswers(
        declared_categories=declared_categories,
        recurring_overrides=recurring_overrides,
        declared_recurring=declared_recurring,
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


def _answered_obligation(obligation: FinancialObligation) -> FinancialObligation:
    """One recurring obligation with the user's category answer and edits applied.

    An override is looked up by id. If a rebuild no longer produces that id the
    override is simply not applied -- it stays on disk against the day the payment
    reappears, and never raises (PER-2).
    """
    if obligation.id in declared_categories:
        obligation = obligation.model_copy(
            update={"declared_category": declared_categories[obligation.id]}
        )
    override = recurring_overrides.get(obligation.id)
    if override is None:
        return obligation
    edits = override.model_dump(exclude_none=True)
    if not edits:
        return obligation
    if any(field in edits for field in OVERRIDDEN_VALUES):
        edits["provenance"] = "declared"
    return obligation.model_copy(update=edits)


def apply_answers(twin: FinancialTwin) -> FinancialTwin:
    """Layer every saved declaration over a newly loaded or rebuilt twin (PER-9)."""
    _load()
    obligations = [
        _answered_obligation(obligation)
        for obligation in [*twin.obligations, *declared_recurring]
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


def get_twin() -> FinancialTwin:
    """The twin from whichever source is configured, with the user's answers applied."""
    return apply_answers(load_source_twin())


def declare_category(obligation_id: str, category: ObligationCategory) -> FinancialTwin:
    if obligation_id not in {o.id for o in get_twin().obligations}:
        raise UnknownObligation(obligation_id)
    declared_categories[obligation_id] = category
    _save()
    return get_twin()


def override_recurring(obligation_id: str, changes: RecurringOverride) -> FinancialTwin:
    """Record the user's edits to one recurring obligation, detected or declared.

    Fully validated before anything is mutated and saved once, under the write lock,
    so a rejected change leaves neither memory nor the answers file touched (PER-7).
    Fields left as `None` keep whatever the obligation has now, so pausing a payment
    does not discard an amount the user corrected earlier.
    """
    with _write_lock:
        _load()
        edits = changes.model_dump(exclude_none=True)
        if not edits:
            raise InvalidDeclaration("At least one field must be given")
        if obligation_id not in {o.id for o in get_twin().obligations}:
            raise UnknownObligation(obligation_id)
        current = recurring_overrides.get(obligation_id, RecurringOverride())
        recurring_overrides[obligation_id] = current.model_copy(update=edits)
        _save()
        return get_twin()


def _recurring_slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "payment"


def _unique_recurring_id(name: str, taken: set[str]) -> str:
    base = f"rec_{_recurring_slug(name)}"
    obligation_id = base
    suffix = 2
    while obligation_id in taken:
        obligation_id = f"{base}_{suffix}"
        suffix += 1
    return obligation_id


def add_declared_recurring(request: RecurringObligationCreate) -> FinancialTwin:
    """Add one user-declared monthly payment without changing observed structure."""
    with _write_lock:
        _load()
        duplicate = next(
            (
                obligation
                for obligation in map(_answered_obligation, declared_recurring)
                if obligation.active and obligation.name.casefold() == request.name.casefold()
            ),
            None,
        )
        if duplicate is not None:
            raise InvalidDeclaration(
                f"An active recurring obligation named '{request.name}' already exists"
            )
        # A vanished detected payment can still own an override/category answer
        # (PER-2). Reserve those ids so a new declaration cannot inherit stale edits.
        taken = {obligation.id for obligation in get_twin().obligations}
        taken.update(recurring_overrides)
        taken.update(declared_categories)
        declared_recurring.append(
            FinancialObligation(
                id=_unique_recurring_id(request.name, taken),
                name=request.name,
                expected_amount=request.amount,
                due_day=request.due_day,
                mandatory=request.mandatory,
                confidence=1.0,
                provenance="declared",
                category_candidates=[],
                declared_category=None,
                active=True,
            )
        )
        _save()
        return get_twin()


def delete_declared_recurring(obligation_id: str) -> FinancialTwin:
    """Delete a declared payment; detected payments can only be paused (PER-4)."""
    with _write_lock:
        _load()
        index = next(
            (
                index
                for index, obligation in enumerate(declared_recurring)
                if obligation.id == obligation_id
            ),
            None,
        )
        if index is None:
            if obligation_id in {obligation.id for obligation in get_twin().obligations}:
                raise DetectedObligationCannotBeDeleted(
                    "Detected payments can be paused, not deleted."
                )
            raise UnknownObligation(obligation_id)
        declared_recurring.pop(index)
        recurring_overrides.pop(obligation_id, None)
        declared_categories.pop(obligation_id, None)
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


def _unique_one_time_id(name: str, taken: set[str]) -> str:
    """Return the compiler's one_<slug> shape without colliding with saved rows."""
    # Match goal_compiler.unique_obligation_id, including its fallback for a name
    # containing no letters or digits, without coupling the persistence layer to the
    # natural-language compiler.
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "goal"
    base = f"one_{slug}"
    obligation_id = base
    suffix = 2
    while obligation_id in taken:
        obligation_id = f"{base}_{suffix}"
        suffix += 1
    return obligation_id


def _check_managed_one_time(obligation: OneTimeObligation, twin: FinancialTwin) -> None:
    """Validate the stricter date/account rules on the management routes (G-11)."""
    latest = twin.as_of + timedelta(days=MAX_HORIZON_DAYS)
    if not twin.as_of < obligation.due_date <= latest:
        raise InvalidDeclaration(
            f"One-time obligation due date {obligation.due_date} must be after "
            f"{twin.as_of} and no later than {latest}"
        )
    if obligation.account_id not in {account.id for account in twin.accounts}:
        raise InvalidDeclaration(f"Unknown account_id '{obligation.account_id}'")


def add_one_time_obligation(request: OneTimeObligationCreate) -> FinancialTwin:
    """Add one declared future expense after validating everything (PER-7)."""
    global declared_one_time_obligations
    with _write_lock:
        current = get_twin()
        owed = list(current.one_time_obligations)
        obligation = OneTimeObligation(
            id=_unique_one_time_id(request.name, {item.id for item in owed}),
            name=request.name,
            amount=request.amount,
            due_date=request.due_date,
            account_id=request.account_id,
            mandatory=request.mandatory,
        )
        _check_managed_one_time(obligation, current)
        owed.append(obligation)
        declared_one_time_obligations = owed
        _save()
        return get_twin()


def update_one_time_obligation(
    obligation_id: str, request: OneTimeObligationChanges
) -> FinancialTwin:
    """Apply a partial edit to one declared future expense (PER-7)."""
    global declared_one_time_obligations
    with _write_lock:
        current = get_twin()
        owed = list(current.one_time_obligations)
        index = next(
            (index for index, obligation in enumerate(owed) if obligation.id == obligation_id),
            None,
        )
        if index is None:
            raise UnknownObligation(obligation_id)
        changes = request.model_dump(exclude_none=True)
        if not changes:
            raise InvalidDeclaration("At least one field must be given")
        updated = owed[index].model_copy(update=changes)
        _check_managed_one_time(updated, current)
        owed[index] = updated
        declared_one_time_obligations = owed
        _save()
        return get_twin()


def delete_one_time_obligation(obligation_id: str) -> FinancialTwin:
    """Delete one declared future expense, including a committed purchase (CM-7)."""
    global declared_one_time_obligations
    with _write_lock:
        current = get_twin()
        owed = list(current.one_time_obligations)
        index = next(
            (index for index, obligation in enumerate(owed) if obligation.id == obligation_id),
            None,
        )
        if index is None:
            raise UnknownObligation(obligation_id)
        owed.pop(index)
        declared_one_time_obligations = owed
        _save()
        return get_twin()


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


class UnknownGoal(KeyError):
    pass


class StaleDeadline(ValueError):
    """The client's `from_deadline` is not the deadline on the twin (CM-4)."""


def purchase_obligation(event: SimulationEvent) -> OneTimeObligation:
    """The one-time obligation a committed purchase becomes (CM-3, A9).

    The id is derived from the purchase itself, so committing the same purchase twice
    writes one record (G-15). Non-mandatory on purpose: a mandatory one would later
    count as an unpayable bill and make the plan look worse than it is.
    """
    material = "|".join(
        [event.description, f"{event.amount:.2f}", event.date.isoformat(), event.account_id]
    )
    digest = hashlib.sha1(material.encode()).hexdigest()[:10]
    return OneTimeObligation(
        id=f"one_purchase_{digest}",
        name=event.description,
        amount=event.amount,
        due_date=event.date,
        account_id=event.account_id,
        mandatory=False,
    )


def apply_goal_updates(goals: list[Goal], updates: list[GoalDateChange], as_of: date) -> list[Goal]:
    """The goals with each update applied, or an exception and no change at all (CM-4)."""
    latest = as_of + timedelta(days=MAX_HORIZON_DAYS)
    by_id = {g.id: g for g in goals}
    if len({u.goal_id for u in updates}) != len(updates):
        raise InvalidDeclaration("A goal can only be moved once per commit")
    for update in updates:
        goal = by_id.get(update.goal_id)
        if goal is None:
            raise UnknownGoal(update.goal_id)
        if goal.deadline != update.from_deadline:
            raise StaleDeadline(
                f"Goal '{goal.id}' is now due {goal.deadline}, not {update.from_deadline}. "
                "Simulate again before moving it."
            )
        if update.deadline <= goal.deadline:
            raise InvalidDeclaration(
                f"Goal '{goal.id}' can only move later than {goal.deadline}, not to {update.deadline}"
            )
        if update.deadline > latest:
            raise InvalidDeclaration(
                f"Goal '{goal.id}' deadline {update.deadline} is more than {MAX_HORIZON_DAYS} "
                f"days after {as_of}"
            )
    moved = {u.goal_id: u.deadline for u in updates}
    return [g.model_copy(update={"deadline": moved[g.id]}) if g.id in moved else g for g in goals]


def commit_purchase(
    events: list[SimulationEvent], goal_updates: list[GoalDateChange] | None = None
) -> tuple[FinancialTwin, list[str], bool]:
    """Add a purchase to the plan, optionally moving a goal in the same call (CM-3, CM-4).

    Returns the updated twin, the one-time obligation ids this purchase is on the twin
    as, and whether it was already there. Everything is validated before anything is
    written, under one lock, and saved once (PER-7): a rejected commit leaves neither
    the goal nor the purchase changed.
    """
    global declared_goals, declared_one_time_obligations
    with _write_lock:
        current = get_twin()
        (event,) = events
        obligation = purchase_obligation(event)
        owed = list(current.one_time_obligations)
        already_committed = any(o.id == obligation.id for o in owed)
        if not already_committed:
            owed.append(obligation)
        check_one_time_obligations(owed, current)
        goals = apply_goal_updates(list(current.goals), goal_updates or [], current.as_of)

        declared_goals = goals
        declared_one_time_obligations = owed
        _save()
        return get_twin(), [obligation.id], already_committed


def reset() -> None:
    """Forget answers in memory. The saved file is left alone and not re-read."""
    global minimum_checking_balance, declared_goals, declared_reserves, _loaded
    global declared_one_time_obligations
    _loaded = True
    declared_categories.clear()
    recurring_overrides.clear()
    declared_recurring.clear()
    minimum_checking_balance = None
    declared_goals = None
    declared_reserves = None
    declared_one_time_obligations = None
