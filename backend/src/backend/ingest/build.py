"""Assembling a Financial Twin from a transaction history.

The last step of Workstream 1's pipeline. It does one thing worth stating
plainly, because it is the whole point of the module:

* income, obligations and variable spending are **observed**. They are computed
  here, from the transactions, and recomputing them can change them.
* goals and constraints are **declared**. They come in from the caller and go
  out untouched. No amount of transaction history can tell you that someone
  needs $2,000 for summer housing by May (SPEC section 2).
* account balances are **reported**, not derived. A statement records what moved,
  not what is left, so balances are an input too.

The forecast behind the observed figures is computed in `backend.forecast`
during detection; this module only carries its metadata onto the twin.
"""

from datetime import date

from backend.ingest.recurrence import detect_structure
from backend.schemas import (
    Account,
    FinancialConstraint,
    FinancialTwin,
    Goal,
    Transaction,
)


def latest_transaction_date(transactions: list[Transaction]) -> date | None:
    """The day the history runs up to, or None when there is no history."""
    return max((t.date for t in transactions), default=None)


def build_twin(
    user_id: str,
    display_name: str,
    accounts: list[Account],
    transactions: list[Transaction],
    as_of: date,
    goals: list[Goal],
    constraints: list[FinancialConstraint],
) -> FinancialTwin:
    """A twin whose observed half is detected and whose declared half is carried."""
    structure = detect_structure(transactions, as_of)
    return FinancialTwin(
        user_id=user_id,
        display_name=display_name,
        as_of=as_of,
        accounts=accounts,
        income=structure.income,
        obligations=structure.obligations,
        variable_spending=structure.variable_spending,
        goals=goals,
        constraints=constraints,
        forecast=structure.forecast,
    )


def rebuild(twin: FinancialTwin, transactions: list[Transaction], as_of: date) -> FinancialTwin:
    """Rebuild an existing twin's observed half from transactions.

    Its identity, balances, goals and constraints — everything the user told us
    or the bank reported — carry over unchanged.
    """
    return build_twin(
        user_id=twin.user_id,
        display_name=twin.display_name,
        accounts=twin.accounts,
        transactions=transactions,
        as_of=as_of,
        goals=twin.goals,
        constraints=twin.constraints,
    )
