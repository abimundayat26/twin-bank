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


def test_simulate_rejects_invalid_request():
    bad = {**LAPTOP_REQUEST, "events": []}
    assert client.post("/simulate", json=bad).status_code == 422
