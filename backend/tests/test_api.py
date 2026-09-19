from fastapi.testclient import TestClient

from backend.fixtures import load_twin
from backend.main import app
from backend.schemas import FinancialTwin, SimulationResponse

client = TestClient(app)

LAPTOP_REQUEST = {
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


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_get_twin_alex_conforms_to_schema():
    response = client.get("/twin/alex")
    assert response.status_code == 200
    twin = FinancialTwin.model_validate(response.json())
    assert twin.user_id == "alex"


def test_get_twin_alex_matches_fixture():
    response = client.get("/twin/alex")
    twin = FinancialTwin.model_validate(response.json())
    assert twin == load_twin()


def test_get_twin_unknown_user_404():
    assert client.get("/twin/nobody").status_code == 404


def test_simulate_conforms_to_schema():
    response = client.post("/simulate", json=LAPTOP_REQUEST)
    assert response.status_code == 200
    result = SimulationResponse.model_validate(response.json())
    assert result.counterfactual.ending_balance < result.baseline.ending_balance
    assert result.is_mock is False


def test_simulate_laptop_shows_goal_shortfall():
    result = SimulationResponse.model_validate(client.post("/simulate", json=LAPTOP_REQUEST).json())
    assert result.baseline.goal_shortfall == 0
    assert result.counterfactual.goal_shortfall > 0
    assert result.summary
    assert result.drivers[0].impact_amount == -800


def test_simulate_unknown_account_422():
    event = {**LAPTOP_REQUEST["events"][0], "account_id": "acc_nope"}
    assert client.post("/simulate", json={**LAPTOP_REQUEST, "events": [event]}).status_code == 422


def test_simulate_horizon_too_long_422():
    response = client.post("/simulate", json={**LAPTOP_REQUEST, "horizon_end": "2030-01-01"})
    assert response.status_code == 422
    assert "days after as_of" in response.json()["detail"]


def test_simulate_unknown_user_404():
    assert client.post("/simulate", json={**LAPTOP_REQUEST, "user_id": "nobody"}).status_code == 404


def test_simulate_rejects_invalid_request():
    bad = {**LAPTOP_REQUEST, "events": []}
    assert client.post("/simulate", json=bad).status_code == 422


def test_simulate_returns_monte_carlo_probabilities():
    result = SimulationResponse.model_validate(client.post("/simulate", json=LAPTOP_REQUEST).json())
    assert result.counterfactual.prob_low_balance > result.baseline.prob_low_balance
    assert 0 < result.counterfactual.prob_below_reserve < 1
    assert "simulated futures" in result.summary
