"""The frontend's offline fallbacks in frontend/lib/mock/ must match backend/fixtures/."""

import json
from pathlib import Path

import pytest

from backend.fixtures import FIXTURES_DIR, load_twin
from backend.forecast_view import build_forecast
from backend.overview import build_overview

FRONTEND_MOCKS = Path(__file__).resolve().parents[2] / "frontend" / "lib" / "mock"

pytestmark = pytest.mark.skipif(not FRONTEND_MOCKS.exists(), reason="frontend not checked out")


def test_frontend_twin_mock_matches_fixture():
    mock = json.loads((FRONTEND_MOCKS / "twin.json").read_text())
    assert mock == load_twin().model_dump(mode="json")


def test_frontend_simulation_mock_matches_fixture():
    mock = json.loads((FRONTEND_MOCKS / "simulation.json").read_text())
    assert mock == json.loads((FIXTURES_DIR / "simulation.json").read_text())


def test_frontend_overview_mock_matches_builder():
    mock = json.loads((FRONTEND_MOCKS / "overview.json").read_text())
    assert mock == build_overview(load_twin()).model_dump(mode="json")


def test_frontend_forecast_mock_matches_builder():
    mock = json.loads((FRONTEND_MOCKS / "forecast.json").read_text())
    expected = build_forecast(load_twin(), seed=1, is_mock=True)
    assert mock == expected.model_dump(mode="json")
