"""Load Phase 1 mock fixtures from backend/fixtures/."""

import json
from pathlib import Path
from typing import TYPE_CHECKING

from backend.schemas import FinancialTwin, SimulationResponse

if TYPE_CHECKING:
    from backend.ingest.models import RawTransaction

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"


def load_twin() -> FinancialTwin:
    return FinancialTwin.model_validate_json((FIXTURES_DIR / "twin.json").read_text())


def load_simulation() -> SimulationResponse:
    return SimulationResponse.model_validate_json((FIXTURES_DIR / "simulation.json").read_text())


def load_raw_transactions() -> list["RawTransaction"]:
    """Alex's mock raw banking feed, standing in for Nessie until Phase 3.

    Imported lazily so this module keeps no dependency on the ingest package.
    """
    from backend.ingest.models import RawTransaction

    records = json.loads((FIXTURES_DIR / "transactions.json").read_text())
    return [RawTransaction.model_validate(record) for record in records]
