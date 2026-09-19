"""In-memory user answers layered on top of the mock twin fixture.

Answers (declared obligation categories, the minimum checking balance, confirmed
goals and emergency reserve) live in process memory and reset when the server restarts. Nothing here calculates money.
"""

from datetime import timedelta

from backend.fixtures import load_twin
from backend.schemas import FinancialConstraint, FinancialTwin, Goal, ObligationCategory
from backend.simulation.engine import MAX_HORIZON_DAYS

MINIMUM_BALANCE_ID = "con_minimum_checking"

declared_categories: dict[str, ObligationCategory] = {}  # obligation id -> answer
minimum_checking_balance: float | None = None
# None means "not answered yet": the fixture's goals and reserve apply.
declared_goals: list[Goal] | None = None
declared_reserves: list[FinancialConstraint] | None = None


class UnknownObligation(KeyError):
    pass


class InvalidDeclaration(ValueError):
    pass


def get_twin() -> FinancialTwin:
    """The fixture twin with the user's answers applied."""
    twin = load_twin()
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
    return twin.model_copy(
        update={"obligations": obligations, "constraints": constraints, "goals": goals}
    )


def declare_category(obligation_id: str, category: ObligationCategory) -> FinancialTwin:
    if obligation_id not in {o.id for o in load_twin().obligations}:
        raise UnknownObligation(obligation_id)
    declared_categories[obligation_id] = category
    return get_twin()


def set_minimum_checking_balance(amount: float) -> FinancialTwin:
    global minimum_checking_balance
    minimum_checking_balance = amount
    return get_twin()


def set_goals(goals: list[Goal], constraints: list[FinancialConstraint]) -> FinancialTwin:
    """Replace the goals and emergency reserve. A checking minimum in constraints is
    saved as the minimum checking balance; leaving it out keeps the current one."""
    global declared_goals, declared_reserves
    as_of = load_twin().as_of
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
    floor = next((c for c in constraints if c.type == "minimum_checking_balance"), None)
    declared_goals = list(goals)
    declared_reserves = [c for c in constraints if c.type == "minimum_reserve"]
    if floor is not None:
        set_minimum_checking_balance(floor.amount)
    return get_twin()


def reset() -> None:
    global minimum_checking_balance, declared_goals, declared_reserves
    declared_categories.clear()
    minimum_checking_balance = None
    declared_goals = None
    declared_reserves = None
