"""Regenerate the frontend's offline fallback fixtures from the API payloads.

`frontend/lib/mock/*.json` are what the frontend falls back to when the backend
is unreachable, so they must match what the API actually serves. Run this after
changing anything in backend/fixtures/:

    cd backend && uv run python -m backend.sync_frontend_mocks

`tests/test_frontend_mocks.py` fails if the two ever drift apart.
"""

import json
from pathlib import Path

from backend.fixtures import load_simulation, load_twin
from backend.forecast_view import build_forecast
from backend.overview import build_overview

REPO_ROOT = Path(__file__).resolve().parents[3]
FRONTEND_MOCK_DIR = REPO_ROOT / "frontend" / "lib" / "mock"


def sync() -> list[Path]:
    """Write each fixture as the API serializes it. Returns the paths written."""
    twin = load_twin()
    payloads = {
        "twin.json": twin,
        "simulation.json": load_simulation(),
        "overview.json": build_overview(twin),
        "forecast.json": build_forecast(twin, seed=1, is_mock=True),
    }
    written = []
    for name, model in payloads.items():
        path = FRONTEND_MOCK_DIR / name
        payload = json.dumps(model.model_dump(mode="json"), indent=2, ensure_ascii=False)
        path.write_text(payload + "\n")
        written.append(path)
    return written


if __name__ == "__main__":
    for path in sync():
        print(f"wrote {path.relative_to(REPO_ROOT)}")
