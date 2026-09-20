"""Load Phase 1 mock fixtures from backend/fixtures/."""

import json
from pathlib import Path
from typing import TYPE_CHECKING

from backend.schemas import FinancialTwin, SimulationResponse

if TYPE_CHECKING:
    from backend.ingest.models import RawTransaction

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"


def load_twin() -> FinancialTwin:
    """Alex's demo twin: what the app serves and what the frontend mocks mirror."""
    return FinancialTwin.model_validate_json((FIXTURES_DIR / "twin.json").read_text())


def load_seed_twin() -> FinancialTwin:
    """The hand-written twin the mock transaction feed is generated from.

    Only two things read this: `ingest.generate_transactions`, which turns it
    into a year of plausible statement rows, and the tests that check the
    detector rediscovered what was put in.

    It exists because the two fixtures used to be one, which made them circular:
    the feed was generated from `twin.json` while a rebuild derived `twin.json`
    from the feed. Splitting the roles gives each file one job. The seed is the
    *input* — the structure a detector is supposed to find — and `twin.json` is
    the *output*. Nothing the app serves should read the seed, or a test that
    compares the two would be comparing a file with itself.
    """
    return FinancialTwin.model_validate_json((FIXTURES_DIR / "twin_seed.json").read_text())


def load_simulation() -> SimulationResponse:
    return SimulationResponse.model_validate_json((FIXTURES_DIR / "simulation.json").read_text())


def load_raw_transactions() -> list["RawTransaction"]:
    """Alex's mock raw banking feed, standing in for Nessie until Phase 3.

    Imported lazily so this module keeps no dependency on the ingest package.
    """
    from backend.ingest.models import RawTransaction

    records = json.loads((FIXTURES_DIR / "transactions.json").read_text())
    return [RawTransaction.model_validate(record) for record in records]
