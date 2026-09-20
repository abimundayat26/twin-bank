"""Goal edits and the emergency reserve (PL-9, PL-10, PER-7, PER-8)."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from backend import twin_store
from backend.goal_compiler import RESERVE_ID
from backend.main import app
from backend.schemas import FinancialTwin
from backend.simulation.engine import MAX_HORIZON_DAYS

client = TestClient(app)

GOAL = "goal_summer_housing"


def served_twin() -> FinancialTwin:
    return twin_store.get_twin()


def goal_on(response, goal_id: str = GOAL):
    twin = FinancialTwin.model_validate(response.json())
    return next(goal for goal in twin.goals if goal.id == goal_id)


def reserve_on(twin: FinancialTwin):
    return next((c for c in twin.constraints if c.type == "minimum_reserve"), None)


def declare_two_goals() -> None:
    """Both of Alex's goals declared, so a delete has something to leave behind."""
    existing = served_twin().goals[0]
    second = existing.model_copy(
        update={"id": "goal_new_bike", "name": "New bike", "target_amount": 400}
    )
    response = client.put(
        "/twin/alex/goals",
        json={"goals": [g.model_dump(mode="json") for g in (existing, second)]},
    )
    assert response.status_code == 200


# --- PATCH /twin/{user_id}/goals/{goal_id} (PL-10) ---------------------------


def test_patch_changes_one_field_and_leaves_the_others_alone():
    before = served_twin().goals[0]

    response = client.patch(f"/twin/alex/goals/{GOAL}", json={"target_amount": 2100})

    assert response.status_code == 200
    updated = goal_on(response)
    assert updated.target_amount == 2100
    assert (updated.name, updated.deadline, updated.current_amount) == (
        before.name,
        before.deadline,
        before.current_amount,
    )


def test_patch_works_on_a_goal_that_was_never_declared():
    # declared_goals is still None here, so the goal on screen is the fixture's. The
    # edit has to seed the list from the served twin rather than 404.
    assert twin_store.declared_goals is None

    response = client.patch(f"/twin/alex/goals/{GOAL}", json={"name": "  Summer   rent "})

    assert response.status_code == 200
    assert goal_on(response).name == "Summer rent"


def test_patch_returns_the_whole_updated_twin():
    response = client.patch(f"/twin/alex/goals/{GOAL}", json={"current_amount": 250})

    assert response.status_code == 200
    assert FinancialTwin.model_validate(response.json()) == served_twin()


@pytest.mark.parametrize("body", [{}, {"name": None}])
def test_patch_without_a_field_is_422_and_changes_nothing(body):
    before = served_twin()

    response = client.patch(f"/twin/alex/goals/{GOAL}", json=body)

    assert response.status_code == 422
    assert served_twin() == before


@pytest.mark.parametrize("offset", [-1, 0, MAX_HORIZON_DAYS + 1])
def test_patch_rejects_a_deadline_outside_the_horizon(offset):
    as_of = served_twin().as_of
    latest = as_of + timedelta(days=MAX_HORIZON_DAYS)
    deadline = as_of + timedelta(days=offset)
    before = served_twin()

    response = client.patch(
        f"/twin/alex/goals/{GOAL}", json={"deadline": deadline.isoformat()}
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": f"Goal '{GOAL}' deadline {deadline} must be after {as_of} and no later than {latest}"
    }
    assert served_twin() == before


def test_patch_accepts_the_last_day_of_the_horizon():
    latest = served_twin().as_of + timedelta(days=MAX_HORIZON_DAYS)

    response = client.patch(
        f"/twin/alex/goals/{GOAL}", json={"deadline": latest.isoformat()}
    )

    assert response.status_code == 200
    assert goal_on(response).deadline == latest


@pytest.mark.parametrize("body", [{"target_amount": 0}, {"target_amount": -50}])
def test_patch_rejects_a_target_amount_of_zero_or_less(body):
    before = served_twin()

    response = client.patch(f"/twin/alex/goals/{GOAL}", json=body)

    assert response.status_code == 422
    assert served_twin() == before


def test_patch_unknown_goal_is_404():
    response = client.patch("/twin/alex/goals/goal_nope", json={"target_amount": 900})

    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown goal 'goal_nope'"}


def test_patched_goal_survives_a_store_restart():
    assert client.patch(f"/twin/alex/goals/{GOAL}", json={"target_amount": 2100}).status_code == 200

    twin_store.reset()
    twin_store._loaded = False

    assert next(g for g in served_twin().goals if g.id == GOAL).target_amount == 2100


# --- DELETE /twin/{user_id}/goals/{goal_id} ----------------------------------


def test_delete_removes_only_the_named_goal_and_returns_the_whole_twin():
    declare_two_goals()

    response = client.delete(f"/twin/alex/goals/{GOAL}")

    assert response.status_code == 200
    twin = FinancialTwin.model_validate(response.json())
    assert [goal.id for goal in twin.goals] == ["goal_new_bike"]
    assert twin == served_twin()


def test_delete_works_on_a_goal_that_was_never_declared():
    assert twin_store.declared_goals is None

    response = client.delete(f"/twin/alex/goals/{GOAL}")

    assert response.status_code == 200
    assert FinancialTwin.model_validate(response.json()).goals == []


def test_delete_unknown_goal_is_404():
    before = served_twin()

    response = client.delete("/twin/alex/goals/goal_nope")

    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown goal 'goal_nope'"}
    assert served_twin() == before


# --- PUT /twin/{user_id}/reserve (PL-9) --------------------------------------


def test_put_reserve_sets_one_declared_minimum_reserve():
    response = client.put("/twin/alex/reserve", json={"amount": 2000})

    assert response.status_code == 200
    twin = FinancialTwin.model_validate(response.json())
    reserve = reserve_on(twin)
    assert (reserve.id, reserve.type, reserve.amount) == (
        RESERVE_ID,
        "minimum_reserve",
        2000,
    )
    assert reserve.description == "Keep at least $2,000 across checking and savings for emergencies."
    assert reserve.provenance == "declared"
    assert [c.type for c in twin.constraints].count("minimum_reserve") == 1


def test_put_reserve_zero_removes_it():
    assert client.put("/twin/alex/reserve", json={"amount": 2000}).status_code == 200

    response = client.put("/twin/alex/reserve", json={"amount": 0})

    assert response.status_code == 200
    assert reserve_on(FinancialTwin.model_validate(response.json())) is None


@pytest.mark.parametrize("amount", [-1, -0.01])
def test_put_reserve_rejects_a_negative_amount(amount):
    before = served_twin()

    response = client.put("/twin/alex/reserve", json={"amount": amount})

    assert response.status_code == 422
    assert served_twin() == before


def test_put_reserve_leaves_the_minimum_checking_balance_alone():
    assert client.put("/twin/alex/minimum-balance", json={"amount": 300}).status_code == 200

    response = client.put("/twin/alex/reserve", json={"amount": 2000})

    assert response.status_code == 200
    twin = FinancialTwin.model_validate(response.json())
    floor = next(c for c in twin.constraints if c.type == "minimum_checking_balance")
    assert floor.amount == 300
    assert reserve_on(twin).amount == 2000


def test_reserve_survives_a_store_restart():
    assert client.put("/twin/alex/reserve", json={"amount": 2000}).status_code == 200

    twin_store.reset()
    twin_store._loaded = False

    assert reserve_on(served_twin()).amount == 2000


def test_memory_only_mode_keeps_all_three_writes_working(monkeypatch):
    """`TWIN_ANSWERS_PATH=''` stores nothing, and every write still applies (PER-8)."""
    monkeypatch.setattr(twin_store, "answers_path", None)

    assert client.patch(f"/twin/alex/goals/{GOAL}", json={"target_amount": 2100}).status_code == 200
    assert client.put("/twin/alex/reserve", json={"amount": 2000}).status_code == 200
    assert client.delete(f"/twin/alex/goals/{GOAL}").status_code == 200

    twin = served_twin()
    assert twin.goals == []
    assert reserve_on(twin).amount == 2000


# --- Unknown user ------------------------------------------------------------


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("patch", f"/twin/nobody/goals/{GOAL}", {"target_amount": 900}),
        ("delete", f"/twin/nobody/goals/{GOAL}", None),
        ("put", "/twin/nobody/reserve", {"amount": 2000}),
    ],
)
def test_unknown_user_keeps_the_exact_404(method, path, body):
    call = getattr(client, method)
    response = call(path) if body is None else call(path, json=body)

    assert response.status_code == 404
    assert response.json() == {"detail": "No twin for user 'nobody'"}
