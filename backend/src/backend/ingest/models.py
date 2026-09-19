"""The raw, per-provider end of the ingest pipeline.

`Transaction` and `Category` now live in `schemas.py`: `POST /twin/build` takes
transactions, so they are a shared contract. They are re-exported here so that
`backend.ingest` still describes the whole pipeline in one import.

`RawTransaction` stays here. It is the shape one source feed happens to use, not
something other workstreams consume.

Conventions match the rest of the project: money is USD dollars, dates are ISO
8601. On a normalized `Transaction` the amount is *signed* — positive is money
in, negative is money out — which is the one thing the raw feeds disagree about.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

from backend.schemas import Category, Transaction

__all__ = ["Category", "RawTransaction", "RawType", "Transaction"]

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
