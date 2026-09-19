"""Transaction types for the ingest pipeline.

These are deliberately *not* in `schemas.py` yet. Nothing outside this package
consumes them, and CLAUDE.md asks for shared-contract changes in their own small
PR; promote `Transaction` when `POST /twin/build` puts it on the API surface.

Conventions match the rest of the project: money is USD dollars, dates are ISO
8601. On a normalized `Transaction` the amount is *signed* — positive is money
in, negative is money out — which is the one thing the raw feeds disagree about.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

# What the money was for. "transfer" means money moved between accounts or to an
# unknown destination: the normalizer must not guess that a transfer is savings,
# a loan repayment or anything else (SPEC section 2).
Category = Literal[
    "income",
    "rent",
    "utilities",
    "phone",
    "subscriptions",
    "groceries",
    "discretionary",
    "transfer",
    "other",
]

# Nessie's vocabulary for which way the money moved.
RawType = Literal["deposit", "withdrawal", "purchase", "transfer"]


class RawTransaction(BaseModel):
    """One banking event as the source feed reports it.

    Modelled on the Capital One Nessie payload: an unsigned `amount` whose
    direction is implied by `type`, and a free-text `description`. The mock feed
    in `fixtures/transactions.json` uses this shape so that swapping in the real
    Nessie client later changes where the records come from, not what they are.
    """

    id: str = Field(alias="_id")
    account_id: str
    type: RawType
    transaction_date: date
    amount: float = Field(ge=0, description="Unsigned; direction comes from `type`.")
    description: str
    status: str = "completed"

    model_config = {"populate_by_name": True}


class Transaction(BaseModel):
    """One normalized transaction: signed, categorized, ready to analyze."""

    id: str
    account_id: str
    date: date
    amount: float = Field(description="Signed: positive is money in, negative is money out.")
    description: str
    category: Category
    provenance: Literal["observed"] = "observed"
