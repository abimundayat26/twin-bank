from fastapi.testclient import TestClient

from backend import simulation_store
from backend.fixtures import load_simulation
from backend.main import app

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


def test_explain_returns_the_simulation_it_stored():
    simulated = client.post("/simulate", json=LAPTOP_REQUEST).json()

    response = client.get(f"/explain/{simulated['simulation_id']}")

    assert response.status_code == 200
    assert response.json() == simulated


def test_explain_unknown_id_is_404():
    response = client.get("/explain/sim_does_not_exist")
    assert response.status_code == 404
    assert "sim_does_not_exist" in response.json()["detail"]


def test_failed_simulation_is_not_stored():
    bad = {**LAPTOP_REQUEST, "events": [{**LAPTOP_REQUEST["events"][0], "account_id": "acc_nope"}]}
    assert client.post("/simulate", json=bad).status_code == 422
    assert simulation_store.simulations == {}


def test_store_keeps_only_the_newest(monkeypatch):
    monkeypatch.setattr(simulation_store, "MAX_STORED", 2)
    fixture = load_simulation()
    for i in range(3):
        simulation_store.save(fixture.model_copy(update={"simulation_id": f"sim_{i}"}))

    assert simulation_store.get("sim_0") is None
    assert simulation_store.get("sim_1") is not None
    assert simulation_store.get("sim_2") is not None
