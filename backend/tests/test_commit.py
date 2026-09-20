"""Committing a purchase: CM-3, CM-4 and CM-7 from frontend/SPEC.md section 10."""

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from backend import twin_store
from backend.fixtures import load_twin
from backend.main import app
from backend.schemas import CommitPurchaseResponse, GoalDateChange, SimulationEvent
from backend.simulation.engine import MAX_HORIZON_DAYS

client = TestClient(app)

GOAL_ID = "goal_summer_housing"
ORIGINAL_DEADLINE = date(2027, 5, 1)

LAPTOP = SimulationEvent(
    type="purchase",
    description="Laptop",
    amount=800.0,
    date=date(2026, 9, 20),
    account_id="acc_checking",
)
LAPTOP_BODY = {
    "events": [
        {
            "type": "purchase",
            "description": "Laptop",
            "amount": 800,
            "date": "2026-09-20",
            "account_id": "acc_checking",
        }
    ]
}


def test_a_commit_becomes_one_non_mandatory_one_time_obligation():
    twin, created_ids, already = twin_store.commit_purchase([LAPTOP])
    assert already is False
    assert created_ids == [twin_store.purchase_obligation(LAPTOP).id]
    (owed,) = twin.one_time_obligations
    assert owed.id.startswith("one_purchase_")
    assert (owed.name, owed.amount, owed.due_date, owed.account_id) == (
        "Laptop",
        800.0,
        date(2026, 9, 20),
        "acc_checking",
    )
    # A9: mandatory would later read as an unpayable bill (section 2.2 item 6).
    assert owed.mandatory is False
    assert owed.provenance == "declared"


def test_the_id_is_derived_from_the_purchase():
    """CM-3: same purchase, same id; any field different, a different id."""
    base = twin_store.purchase_obligation(LAPTOP)
    assert base.id == twin_store.purchase_obligation(LAPTOP.model_copy()).id
    assert len(base.id) == len("one_purchase_") + 10
    for change in (
        {"description": "Laptop stand"},
        {"amount": 801.0},
        {"date": date(2026, 9, 21)},
        {"account_id": "acc_savings"},
    ):
        assert twin_store.purchase_obligation(LAPTOP.model_copy(update=change)).id != base.id


def test_committing_the_same_purchase_twice_creates_one_record():
    """G-15: a double-click must not buy the laptop twice."""
    twin_store.commit_purchase([LAPTOP])
    twin, created_ids, already = twin_store.commit_purchase([LAPTOP])
    assert already is True
    assert len(twin.one_time_obligations) == 1
    assert created_ids == [twin.one_time_obligations[0].id]


def test_a_purchase_dated_as_of_cannot_be_committed():
    """E-1: it simulates, but there is nothing left to plan for today."""
    twin = load_twin()
    today = LAPTOP.model_copy(update={"date": twin.as_of})
    with pytest.raises(twin_store.InvalidDeclaration):
        twin_store.commit_purchase([today])
    assert twin_store.get_twin().one_time_obligations == []


def test_a_purchase_from_an_unknown_account_cannot_be_committed():
    with pytest.raises(twin_store.InvalidDeclaration):
        twin_store.commit_purchase([LAPTOP.model_copy(update={"account_id": "acc_nope"})])


def test_a_goal_update_moves_the_deadline_in_the_same_call():
    new_deadline = ORIGINAL_DEADLINE + timedelta(days=30)
    twin, _, _ = twin_store.commit_purchase(
        [LAPTOP],
        [GoalDateChange(goal_id=GOAL_ID, from_deadline=ORIGINAL_DEADLINE, deadline=new_deadline)],
    )
    assert [g.deadline for g in twin.goals] == [new_deadline]
    assert len(twin.one_time_obligations) == 1


def test_a_stale_from_deadline_is_rejected_and_changes_nothing():
    """CM-4: the client is acting on a deadline someone else has already moved."""
    with pytest.raises(twin_store.StaleDeadline):
        twin_store.commit_purchase(
            [LAPTOP],
            [
                GoalDateChange(
                    goal_id=GOAL_ID,
                    from_deadline=ORIGINAL_DEADLINE - timedelta(days=1),
                    deadline=ORIGINAL_DEADLINE + timedelta(days=30),
                )
            ],
        )
    twin = twin_store.get_twin()
    # PER-7: atomic, so the purchase is not there either.
    assert twin.one_time_obligations == []
    assert [g.deadline for g in twin.goals] == [ORIGINAL_DEADLINE]


def test_a_goal_can_only_move_later_and_within_two_years():
    as_of = load_twin().as_of
    for deadline in (
        ORIGINAL_DEADLINE,  # not later
        ORIGINAL_DEADLINE - timedelta(days=30),
        as_of + timedelta(days=MAX_HORIZON_DAYS + 1),
    ):
        with pytest.raises(twin_store.InvalidDeclaration):
            twin_store.commit_purchase(
                [LAPTOP],
                [
                    GoalDateChange(
                        goal_id=GOAL_ID, from_deadline=ORIGINAL_DEADLINE, deadline=deadline
                    )
                ],
            )
    assert twin_store.get_twin().one_time_obligations == []


def test_an_unknown_goal_leaves_everything_alone():
    with pytest.raises(twin_store.UnknownGoal):
        twin_store.commit_purchase(
            [LAPTOP],
            [
                GoalDateChange(
                    goal_id="goal_nope",
                    from_deadline=ORIGINAL_DEADLINE,
                    deadline=ORIGINAL_DEADLINE + timedelta(days=30),
                )
            ],
        )
    assert twin_store.get_twin().one_time_obligations == []


def test_the_committed_purchase_is_an_ordinary_editable_row():
    """CM-7: it sits in Obligations like any other, and deleting it is the undo."""
    twin, created_ids, _ = twin_store.commit_purchase([LAPTOP])
    kept = [o for o in twin.one_time_obligations if o.id not in created_ids]
    after = twin_store.set_goals(list(twin.goals), list(twin.constraints), kept)
    assert after.one_time_obligations == []


def test_a_committed_purchase_lowers_the_next_baseline():
    """The point of committing: the plan itself changed, not just the comparison."""
    before = client.post("/simulate", json={"user_id": "alex", **LAPTOP_BODY}).json()
    twin_store.commit_purchase([LAPTOP])
    after = client.post("/simulate", json={"user_id": "alex", **LAPTOP_BODY}).json()
    assert after["baseline"]["ending_balance"] < before["baseline"]["ending_balance"]


def test_route_commits_and_returns_the_whole_twin():
    response = client.post("/twin/alex/purchases/commit", json=LAPTOP_BODY)
    assert response.status_code == 200
    result = CommitPurchaseResponse.model_validate(response.json())
    assert result.already_committed is False
    assert [o.id for o in result.twin.one_time_obligations] == result.created_ids

    again = client.post("/twin/alex/purchases/commit", json=LAPTOP_BODY)
    assert CommitPurchaseResponse.model_validate(again.json()).already_committed is True


def test_route_status_codes():
    assert client.post("/twin/nobody/purchases/commit", json=LAPTOP_BODY).status_code == 404

    unknown_goal = {
        **LAPTOP_BODY,
        "goal_updates": [
            {"goal_id": "goal_nope", "from_deadline": "2027-05-01", "deadline": "2027-05-31"}
        ],
    }
    assert client.post("/twin/alex/purchases/commit", json=unknown_goal).status_code == 404

    stale = {
        **LAPTOP_BODY,
        "goal_updates": [
            {"goal_id": GOAL_ID, "from_deadline": "2027-04-01", "deadline": "2027-05-31"}
        ],
    }
    assert client.post("/twin/alex/purchases/commit", json=stale).status_code == 409

    today = {"events": [{**LAPTOP_BODY["events"][0], "date": "2026-09-18"}]}
    assert client.post("/twin/alex/purchases/commit", json=today).status_code == 422

    assert client.post("/twin/alex/purchases/commit", json={"events": []}).status_code == 422
