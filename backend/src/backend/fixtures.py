"""Load Phase 1 mock fixtures from backend/fixtures/."""

from pathlib import Path

from backend.schemas import FinancialTwin, SimulationResponse

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"


def load_twin() -> FinancialTwin:
    return FinancialTwin.model_validate_json((FIXTURES_DIR / "twin.json").read_text())


def load_simulation() -> SimulationResponse:
    return SimulationResponse.model_validate_json((FIXTURES_DIR / "simulation.json").read_text())
