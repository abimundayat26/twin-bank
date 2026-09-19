"""Turning raw banking events into normalized transactions.

The first half of Workstream 1's pipeline:

    raw bank events -> normalize -> Transaction[] -> (recurrence detection) -> FinancialTwin

Only the normalization half lives here so far. Nothing in this package is wired
into the API yet: `GET /twin/alex` still serves the hand-written fixture, so the
demo is unaffected.
"""

from backend.ingest.models import Category, RawTransaction, Transaction
from backend.ingest.normalize import categorize, normalize, normalize_all

__all__ = [
    "Category",
    "RawTransaction",
    "Transaction",
    "categorize",
    "normalize",
    "normalize_all",
]
