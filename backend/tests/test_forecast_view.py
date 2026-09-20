"""Forecast view and GET /twin/{user_id}/forecast (FD-6 to FD-9)."""

from datetime import date, timedelta

from fastapi.testclient import TestClient

from backend.fixtures import load_twin
from backend.forecast_view import build_forecast, select_extrema
from backend.main import app
from backend.schemas import ForecastPayload

client = TestClient(app)


def test_select_extrema_applies_prominence_caps_and_spacing():
    dates = [date(2026, 1, 1) + timedelta(days=i) for i in range(100)]
    values = [1000.0] * 100
    for center, change in ((20, 300), (30, -250), (60, 220), (85, -180)):
        for offset in range(-5, 6):
            values[center + offset] += change * (1 - abs(offset) / 6)

    selected = select_extrema(values, dates)

    assert [(item.index, item.kind) for item in selected] == [
        (30, "trough"),
        (60, "peak"),
        (85, "trough"),
    ]
    assert all(item.prominence >= 100 for item in selected)


def test_build_forecast_returns_baseline_bands_and_template_callouts():
    twin = load_twin()
    payload = build_forecast(twin, n_simulations=40, seed=1)

    assert payload.user_id == "alex"
    assert payload.horizon_end == min(goal.deadline for goal in twin.goals)
    assert payload.num_simulations == 40
    assert payload.is_mock is False
    assert payload.bands.total[0].date == twin.as_of
    assert len(payload.bands.total) == len(payload.bands.checking)
    assert len(payload.callouts) <= 4
    assert sum(callout.kind == "peak" for callout in payload.callouts) <= 2
    assert sum(callout.kind == "trough" for callout in payload.callouts) <= 2
    for callout in payload.callouts:
        assert callout.label.startswith(callout.date.strftime("%b"))
        assert "High" in callout.label or "Low" in callout.label
        assert not any(word in callout.label.lower() for word in ("christmas", "holiday", "gift"))


def test_forecast_route_conforms_to_contract(monkeypatch):
    monkeypatch.setattr("backend.main.SIMULATION_SEED", 1)
    response = client.get("/twin/alex/forecast")

    assert response.status_code == 200
    payload = ForecastPayload.model_validate(response.json())
    assert payload.user_id == "alex"
    assert payload.bands.total
    assert payload.is_mock is False


def test_forecast_route_unknown_user_404():
    response = client.get("/twin/nobody/forecast")
    assert response.status_code == 404
    assert response.json()["detail"] == "No twin for user 'nobody'"


def test_forecast_does_not_change_simulate_numbers(monkeypatch):
    monkeypatch.setattr("backend.main.SIMULATION_SEED", 7)
    request = {
        "user_id": "alex",
        "events": [
            {
                "type": "purchase",
                "description": "Laptop",
                "amount": 800,
                "date": "2026-09-20",
                "account_id": "acc_checking",
            }
        ],
    }
    before = client.post("/simulate", json=request).json()
    assert client.get("/twin/alex/forecast").status_code == 200
    after = client.post("/simulate", json=request).json()

    assert after["baseline"] == before["baseline"]
    assert after["counterfactual"] == before["counterfactual"]
    assert after["balance_bands"] == before["balance_bands"]
