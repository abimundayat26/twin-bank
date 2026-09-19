"""Turning raw banking events into a Financial Twin's observed structure.

Workstream 1's pipeline:

    raw bank events -> normalize -> Transaction[] -> recurrence detection -> FinancialTwin

Both halves live here now. Nothing in this package is wired into the API yet:
`GET /twin/alex` still serves the hand-written fixture, so the demo is
unaffected by anything detection gets wrong.
"""

from backend.ingest.models import Category, RawTransaction, Transaction
from backend.ingest.normalize import categorize, normalize, normalize_all
from backend.ingest.recurrence import (
    DetectedStructure,
    detect_income,
    detect_obligations,
    detect_structure,
    detect_variable_spending,
)

__all__ = [
    "Category",
    "DetectedStructure",
    "RawTransaction",
    "Transaction",
    "categorize",
    "detect_income",
    "detect_obligations",
    "detect_structure",
    "detect_variable_spending",
    "normalize",
    "normalize_all",
]
