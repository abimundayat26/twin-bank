"""In-memory user answers layered on top of the mock twin fixture.

Answers (declared obligation categories, the minimum checking balance) live in
process memory and reset when the server restarts. Nothing here calculates money.
"""

from backend.fixtures import load_twin
from backend.schemas import FinancialConstraint, FinancialTwin, ObligationCategory

MINIMUM_BALANCE_ID = "con_minimum_checking"

declared_categories: dict[str, ObligationCategory] = {}  # obligation id -> answer
minimum_checking_balance: float | None = None


class UnknownObligation(KeyError):
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
    constraints = [c for c in twin.constraints if c.type != "minimum_checking_balance"]
    if minimum_checking_balance is not None:
        constraints.append(
            FinancialConstraint(
                id=MINIMUM_BALANCE_ID,
                type="minimum_checking_balance",
                amount=minimum_checking_balance,
                description=f"Keep at least ${minimum_checking_balance:,.0f} in checking.",
            )
        )
    return twin.model_copy(update={"obligations": obligations, "constraints": constraints})


def declare_category(obligation_id: str, category: ObligationCategory) -> FinancialTwin:
    if obligation_id not in {o.id for o in load_twin().obligations}:
        raise UnknownObligation(obligation_id)
    declared_categories[obligation_id] = category
    return get_twin()


def set_minimum_checking_balance(amount: float) -> FinancialTwin:
    global minimum_checking_balance
    minimum_checking_balance = amount
    return get_twin()


def reset() -> None:
    global minimum_checking_balance
    declared_categories.clear()
    minimum_checking_balance = None
