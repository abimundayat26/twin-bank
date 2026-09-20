"""POST /clarifications/respond and PUT /twin/{user_id}/minimum-balance."""

from fastapi.testclient import TestClient

from backend.fixtures import load_twin
from backend.main import app
from backend.schemas import FinancialTwin, SimulationResponse

client = TestClient(app)

TRANSFER = "obl_online_transfer_to"
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


def respond(category: str, obligation_id: str = TRANSFER, user_id: str = "alex"):
    return client.post(
        "/clarifications/respond",
        json={"user_id": user_id, "obligation_id": obligation_id, "category": category},
    )


def obligation(twin: FinancialTwin, obligation_id: str = TRANSFER):
    return next(o for o in twin.obligations if o.id == obligation_id)


def test_respond_declares_category_and_persists():
    response = respond("savings_transfer")
    assert response.status_code == 200
    assert obligation(FinancialTwin.model_validate(response.json())).declared_category == "savings_transfer"
    twin = FinancialTwin.model_validate(client.get("/twin/alex").json())
    assert obligation(twin).declared_category == "savings_transfer"
    # Candidates stay, so the user can change their answer.
    assert obligation(twin).category_candidates


def test_respond_can_change_answer():
    respond("savings_transfer")
    twin = FinancialTwin.model_validate(respond("debt_repayment").json())
    assert obligation(twin).declared_category == "debt_repayment"


def test_respond_unknown_obligation_422():
    assert respond("bill", obligation_id="obl_nope").status_code == 422


def test_respond_unknown_category_422():
    assert respond("gift").status_code == 422


def test_respond_unknown_user_404():
    assert respond("bill", user_id="nobody").status_code == 404


def test_answer_changes_simulation():
    before = SimulationResponse.model_validate(client.post("/simulate", json=LAPTOP_REQUEST).json())
    respond("not_recurring")
    after = SimulationResponse.model_validate(client.post("/simulate", json=LAPTOP_REQUEST).json())
    assert after.baseline.ending_balance > before.baseline.ending_balance
    assert any("declared" in a for a in after.assumptions)


def test_minimum_balance_sets_constraint():
    response = client.put("/twin/alex/minimum-balance", json={"amount": 300})
    assert response.status_code == 200
    constraints = FinancialTwin.model_validate(response.json()).constraints
    floors = [c for c in constraints if c.type == "minimum_checking_balance"]
    assert [c.amount for c in floors] == [300]
    reserve = [c for c in constraints if c.type == "minimum_reserve"]
    assert reserve == [c for c in load_twin().constraints if c.type == "minimum_reserve"]


def test_minimum_balance_replaces_previous():
    client.put("/twin/alex/minimum-balance", json={"amount": 300})
    twin = FinancialTwin.model_validate(client.put("/twin/alex/minimum-balance", json={"amount": 0}).json())
    assert [c.amount for c in twin.constraints if c.type == "minimum_checking_balance"] == [0]


def test_minimum_balance_used_in_explanation():
    client.put("/twin/alex/minimum-balance", json={"amount": 5000})
    result = SimulationResponse.model_validate(client.post("/simulate", json=LAPTOP_REQUEST).json())
    assert result.baseline.prob_low_balance == 1
    assert any("$5,000, the minimum Alex set" in a for a in result.assumptions)


def test_minimum_balance_negative_422():
    assert client.put("/twin/alex/minimum-balance", json={"amount": -1}).status_code == 422


def test_minimum_balance_unknown_user_404():
    assert client.put("/twin/nobody/minimum-balance", json={"amount": 300}).status_code == 404


def test_store_starts_clean():
    # The autouse reset in conftest.py means earlier tests' answers never leak.
    served = FinancialTwin.model_validate(client.get("/twin/alex").json())
    assert served == load_twin().model_copy(update={"source": "fixture"})
