"""Read-only Obligations payload and GET route (OB-1, OB-3, OB-4, OB-8, OB-10)."""

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from backend import twin_store
from backend.fixtures import load_twin
from backend.main import app
from backend.obligations import build_obligations
from backend.schemas import (
    CategoryCandidate,
    FinancialObligation,
    FinancialTwin,
    ObligationsPayload,
    OneTimeObligation,
)

client = TestClient(app)


def recurring(
    obligation_id: str,
    name: str,
    amount: float,
    due_day: int,
    *,
    active: bool = True,
    provenance: str = "observed",
    candidates: list[CategoryCandidate] | None = None,
    declared_category: str | None = None,
) -> FinancialObligation:
    return FinancialObligation(
        id=obligation_id,
        name=name,
        expected_amount=amount,
        due_day=due_day,
        mandatory=True,
        confidence=0.73,
        active=active,
        provenance=provenance,
        category_candidates=candidates or [],
        declared_category=declared_category,
    )


def one_time(
    obligation_id: str,
    name: str,
    due_date: date,
    *,
    account_id: str = "acc_checking",
) -> OneTimeObligation:
    return OneTimeObligation(
        id=obligation_id,
        name=name,
        amount=125,
        due_date=due_date,
        account_id=account_id,
        mandatory=True,
    )


def twin_with(**updates):
    values = {
        "obligations": [],
        "one_time_obligations": [],
    }
    values.update(updates)
    return load_twin().model_copy(update=values)


def test_recurring_fields_origin_declared_label_and_paused_visibility():
    twin = twin_with(
        obligations=[
            recurring(
                "observed",
                "Observed bill",
                82.5,
                12,
                active=False,
                declared_category="bill",
            ),
            recurring(
                "declared",
                "Declared transfer",
                50,
                20,
                provenance="declared",
                declared_category="savings_transfer",
            ),
        ]
    )

    payload = build_obligations(twin)

    assert [row.model_dump() for row in payload.recurring] == [
        {
            "id": "observed",
            "name": "Observed bill",
            "amount": 82.5,
            "frequency": "monthly",
            "due_day": 12,
            "active": False,
            "origin": "detected",
            "category_label": "Bill",
            "needs_answer": False,
            "options": [],
        },
        {
            "id": "declared",
            "name": "Declared transfer",
            "amount": 50,
            "frequency": "monthly",
            "due_day": 20,
            "active": True,
            "origin": "declared",
            "category_label": "Savings transfer",
            "needs_answer": False,
            "options": [],
        },
    ]


def test_candidate_options_preserve_order_without_probabilities():
    candidates = [
        CategoryCandidate(category="savings_transfer", probability=0.6),
        CategoryCandidate(category="debt_repayment", probability=0.3),
        CategoryCandidate(category="optional_spending", probability=0.1),
    ]
    row = build_obligations(
        twin_with(obligations=[recurring("unclear", "Unclear", 70, 5, candidates=candidates)])
    ).recurring[0]

    assert row.category_label is None
    assert row.needs_answer is True
    assert [option.model_dump() for option in row.options] == [
        {"category": "savings_transfer", "label": "Savings transfer"},
        {"category": "debt_repayment", "label": "Debt repayment"},
        {"category": "optional_spending", "label": "Optional spending"},
    ]
    assert "probability" not in row.model_dump_json()
    assert "confidence" not in row.model_dump_json()


def test_declared_category_clears_needs_answer_without_guessing():
    candidates = [
        CategoryCandidate(category="savings_transfer", probability=0.7),
        CategoryCandidate(category="debt_repayment", probability=0.3),
    ]
    row = build_obligations(
        twin_with(
            obligations=[
                recurring(
                    "answered",
                    "Answered",
                    90,
                    8,
                    candidates=candidates,
                    declared_category="debt_repayment",
                )
            ]
        )
    ).recurring[0]

    assert row.category_label == "Debt repayment"
    assert row.needs_answer is False
    assert [option.category for option in row.options] == [
        "savings_transfer",
        "debt_repayment",
    ]


def test_recurring_rows_sort_by_due_day_then_name():
    payload = build_obligations(
        twin_with(
            obligations=[
                recurring("later", "Later", 20, 30),
                recurring("zulu", "Zulu", 20, 5),
                recurring("alpha", "Alpha", 20, 5),
            ]
        )
    )

    assert [row.id for row in payload.recurring] == ["alpha", "zulu", "later"]


def test_one_time_rows_are_future_only_sorted_and_resolve_account_names():
    as_of = date(2026, 9, 18)
    payload = build_obligations(
        twin_with(
            as_of=as_of,
            one_time_obligations=[
                one_time("past", "Past", date(2026, 9, 17)),
                one_time("today", "Today", as_of),
                one_time("later", "Later", date(2026, 10, 1), account_id="acc_savings"),
                one_time("zulu", "Zulu", date(2026, 9, 25)),
                one_time("alpha", "Alpha", date(2026, 9, 25)),
            ],
        )
    )

    assert [row.id for row in payload.one_time] == ["alpha", "zulu", "later"]
    assert [row.account_name for row in payload.one_time] == [
        "Everyday Checking",
        "Everyday Checking",
        "Savings",
    ]
    assert set(payload.one_time[0].model_dump()) == {
        "id",
        "name",
        "amount",
        "due_date",
        "account_id",
        "account_name",
        "mandatory",
    }


def test_missing_account_does_not_drop_one_time_obligation():
    payload = build_obligations(
        twin_with(
            accounts=[],
            one_time_obligations=[
                one_time("still_owed", "Still owed", date(2026, 9, 20), account_id="acc_gone")
            ],
        )
    )

    assert [(row.id, row.account_name) for row in payload.one_time] == [
        ("still_owed", "acc_gone")
    ]


def test_empty_twin_returns_both_lists_empty():
    payload = build_obligations(twin_with())

    assert payload.recurring == []
    assert payload.one_time == []
    assert ObligationsPayload.model_validate(payload.model_dump()) == payload


def test_get_route_matches_the_pure_builder():
    response = client.get("/twin/alex/obligations")

    assert response.status_code == 200
    assert ObligationsPayload.model_validate(response.json()) == build_obligations(
        twin_store.get_twin()
    )


def test_get_route_unknown_user_keeps_exact_404():
    response = client.get("/twin/nobody/obligations")

    assert response.status_code == 404
    assert response.json() == {"detail": "No twin for user 'nobody'"}


# --- Recurring writes (OB-2, OB-5 to OB-7) -----------------------------------


RENT = "obl_hokie_property_mgmt_rent"
TRANSFER = "obl_online_transfer_to"


def created_recurring(response, obligation_id: str = "rec_wi_fi_service"):
    twin = FinancialTwin.model_validate(response.json())
    return next(obligation for obligation in twin.obligations if obligation.id == obligation_id)


def test_create_recurring_returns_201_and_the_whole_updated_twin():
    response = client.post(
        "/twin/alex/obligations/recurring",
        json={"name": "  Wi-Fi   service ", "amount": 55, "due_day": 12, "mandatory": False},
    )

    assert response.status_code == 201
    added = created_recurring(response)
    assert added.name == "Wi-Fi service"
    assert added.expected_amount == 55
    assert added.due_day == 12
    assert added.mandatory is False
    assert added.provenance == "declared"
    assert added.confidence == 1
    assert added.active is True
    assert added.category_candidates == []
    assert added.declared_category is None


def test_create_recurring_rejects_a_duplicate_active_declared_name():
    body = {"name": "Wi-Fi", "amount": 55, "due_day": 12}
    assert client.post("/twin/alex/obligations/recurring", json=body).status_code == 201

    response = client.post(
        "/twin/alex/obligations/recurring",
        json={**body, "name": "wi-fi"},
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": "An active recurring obligation named 'wi-fi' already exists"
    }
    assert [o.id for o in twin_store.get_twin().obligations].count("rec_wi_fi") == 1


@pytest.mark.parametrize(
    "body",
    [
        {"name": "", "amount": 55, "due_day": 12},
        {"name": "Wi-Fi", "amount": 0, "due_day": 12},
        {"name": "Wi-Fi", "amount": 55, "due_day": 0},
        {"name": "Wi-Fi", "amount": 1_000_000_001, "due_day": 12},
    ],
)
def test_create_recurring_rejects_invalid_contract_fields(body):
    response = client.post("/twin/alex/obligations/recurring", json=body)

    assert response.status_code == 422
    assert all(o.id != "rec_wi_fi" for o in twin_store.get_twin().obligations)


def test_created_recurring_survives_a_store_restart():
    response = client.post(
        "/twin/alex/obligations/recurring",
        json={"name": "Wi-Fi", "amount": 55, "due_day": 12},
    )
    assert response.status_code == 201

    twin_store.reset()
    twin_store._loaded = False

    listing = client.get("/twin/alex/obligations")
    assert listing.status_code == 200
    assert any(row["id"] == "rec_wi_fi" for row in listing.json()["recurring"])


def test_update_detected_values_makes_the_row_declared():
    response = client.put(
        f"/twin/alex/obligations/recurring/{RENT}",
        json={"name": "Apartment rent", "amount": 700, "due_day": 2},
    )

    assert response.status_code == 200
    updated = created_recurring(response, RENT)
    assert (updated.name, updated.expected_amount, updated.due_day) == (
        "Apartment rent",
        700,
        2,
    )
    assert updated.provenance == "declared"


def test_pausing_a_detected_row_keeps_observed_provenance_and_all_other_fields():
    before = next(o for o in twin_store.get_twin().obligations if o.id == TRANSFER)

    response = client.put(
        f"/twin/alex/obligations/recurring/{TRANSFER}", json={"active": False}
    )

    assert response.status_code == 200
    updated = created_recurring(response, TRANSFER)
    assert updated == before.model_copy(update={"active": False})
    assert updated.provenance == "observed"


def test_update_recurring_rejects_an_empty_body_without_mutating():
    before = twin_store.get_twin()

    response = client.put(f"/twin/alex/obligations/recurring/{RENT}", json={})

    assert response.status_code == 422
    assert twin_store.get_twin() == before


def test_update_unknown_recurring_returns_404():
    response = client.put(
        "/twin/alex/obligations/recurring/rec_missing", json={"active": False}
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown recurring obligation 'rec_missing'"}


def test_delete_declared_recurring_returns_the_updated_twin():
    created = client.post(
        "/twin/alex/obligations/recurring",
        json={"name": "Wi-Fi", "amount": 55, "due_day": 12},
    )
    assert created.status_code == 201

    response = client.delete("/twin/alex/obligations/recurring/rec_wi_fi")

    assert response.status_code == 200
    twin = FinancialTwin.model_validate(response.json())
    assert all(o.id != "rec_wi_fi" for o in twin.obligations)


def test_delete_detected_recurring_returns_required_409():
    response = client.delete(f"/twin/alex/obligations/recurring/{RENT}")

    assert response.status_code == 409
    assert response.json() == {
        "detail": "Detected payments can be paused, not deleted."
    }


def test_delete_unknown_recurring_returns_404():
    response = client.delete("/twin/alex/obligations/recurring/rec_missing")

    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown recurring obligation 'rec_missing'"}


def test_recurring_writes_keep_the_exact_unknown_user_404():
    response = client.post(
        "/twin/nobody/obligations/recurring",
        json={"name": "Wi-Fi", "amount": 55, "due_day": 12},
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "No twin for user 'nobody'"}


# --- One-time writes (OB-2, OB-7, OB-8, G-11) -------------------------------


def post_one_time(
    *,
    name: str = "Tuition deposit",
    amount: float = 400,
    due_date: str = "2026-10-15",
    account_id: str = "acc_checking",
    mandatory: bool = True,
):
    return client.post(
        "/twin/alex/obligations/one-time",
        json={
            "name": name,
            "amount": amount,
            "due_date": due_date,
            "account_id": account_id,
            "mandatory": mandatory,
        },
    )


def response_one_time(response, obligation_id: str = "one_tuition_deposit"):
    twin = FinancialTwin.model_validate(response.json())
    return next(
        obligation
        for obligation in twin.one_time_obligations
        if obligation.id == obligation_id
    )


def test_create_one_time_returns_201_with_a_server_id_and_whole_twin():
    response = post_one_time(name="  Tuition   deposit ", mandatory=False)

    assert response.status_code == 201
    added = response_one_time(response)
    assert added.name == "Tuition deposit"
    assert added.amount == 400
    assert added.due_date == date(2026, 10, 15)
    assert added.account_id == "acc_checking"
    assert added.mandatory is False
    assert added.provenance == "declared"
    assert FinancialTwin.model_validate(response.json()).goals == twin_store.get_twin().goals


def test_create_one_time_uses_a_numeric_id_suffix_on_collision():
    first = post_one_time()
    second = post_one_time()

    assert first.status_code == 201
    assert second.status_code == 201
    twin = FinancialTwin.model_validate(second.json())
    assert [o.id for o in twin.one_time_obligations] == [
        "one_tuition_deposit",
        "one_tuition_deposit_2",
    ]


@pytest.mark.parametrize(
    ("updates", "detail"),
    [
        ({"due_date": "2026-09-18"}, "must be after"),
        ({"due_date": "2028-09-18"}, "no later than"),
        ({"account_id": "acc_missing"}, "Unknown account_id 'acc_missing'"),
    ],
)
def test_create_one_time_rejects_invalid_date_or_account_without_mutating(updates, detail):
    body = {
        "name": "Tuition",
        "amount": 400,
        "due_date": "2026-10-15",
        "account_id": "acc_checking",
        **updates,
    }

    response = client.post("/twin/alex/obligations/one-time", json=body)

    assert response.status_code == 422
    assert detail in response.json()["detail"]
    assert twin_store.get_twin().one_time_obligations == []


@pytest.mark.parametrize(
    "updates",
    [
        {"name": ""},
        {"amount": 0},
        {"amount": 1_000_000_001},
    ],
)
def test_create_one_time_rejects_invalid_contract_fields(updates):
    body = {
        "name": "Tuition",
        "amount": 400,
        "due_date": "2026-10-15",
        "account_id": "acc_checking",
        **updates,
    }

    response = client.post("/twin/alex/obligations/one-time", json=body)

    assert response.status_code == 422
    assert twin_store.get_twin().one_time_obligations == []


def test_create_one_time_accepts_the_exact_730_day_boundary():
    latest = load_twin().as_of + timedelta(days=730)

    response = post_one_time(due_date=latest.isoformat())

    assert response.status_code == 201
    assert response_one_time(response).due_date == latest


def test_update_one_time_changes_only_the_fields_sent():
    created = post_one_time()
    assert created.status_code == 201

    response = client.put(
        "/twin/alex/obligations/one-time/one_tuition_deposit",
        json={
            "name": "Enrollment deposit",
            "amount": 425,
            "due_date": "2026-11-01",
            "account_id": "acc_savings",
            "mandatory": False,
        },
    )

    assert response.status_code == 200
    updated = response_one_time(response)
    assert updated.model_dump() == {
        "id": "one_tuition_deposit",
        "name": "Enrollment deposit",
        "amount": 425.0,
        "due_date": date(2026, 11, 1),
        "account_id": "acc_savings",
        "mandatory": False,
        "provenance": "declared",
    }


@pytest.mark.parametrize(
    "changes",
    [
        {"due_date": "2026-09-18"},
        {"due_date": "2028-09-18"},
        {"account_id": "acc_missing"},
    ],
)
def test_update_one_time_validation_is_atomic(changes):
    created = post_one_time()
    assert created.status_code == 201
    before = twin_store.get_twin()

    response = client.put(
        "/twin/alex/obligations/one-time/one_tuition_deposit", json=changes
    )

    assert response.status_code == 422
    assert twin_store.get_twin() == before


def test_update_one_time_rejects_empty_body_and_unknown_id():
    empty = client.put(
        "/twin/alex/obligations/one-time/one_missing", json={}
    )
    unknown = client.put(
        "/twin/alex/obligations/one-time/one_missing", json={"amount": 500}
    )

    assert empty.status_code == 422
    assert unknown.status_code == 404
    assert unknown.json() == {"detail": "Unknown one-time obligation 'one_missing'"}


def test_delete_one_time_returns_updated_twin_and_keeps_other_rows():
    first = post_one_time()
    second = post_one_time(name="Annual insurance", due_date="2026-12-01")
    assert first.status_code == second.status_code == 201

    response = client.delete(
        "/twin/alex/obligations/one-time/one_tuition_deposit"
    )

    assert response.status_code == 200
    twin = FinancialTwin.model_validate(response.json())
    assert [o.id for o in twin.one_time_obligations] == ["one_annual_insurance"]


def test_delete_one_time_returns_404_for_unknown_id():
    response = client.delete("/twin/alex/obligations/one-time/one_missing")

    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown one-time obligation 'one_missing'"}


def test_one_time_writes_survive_restart_and_work_memory_only(monkeypatch):
    created = post_one_time()
    assert created.status_code == 201
    twin_store.reset()
    twin_store._loaded = False
    assert any(o.id == "one_tuition_deposit" for o in twin_store.get_twin().one_time_obligations)

    twin_store.reset()
    monkeypatch.setattr(twin_store, "answers_path", None)
    memory_only = post_one_time(name="Annual insurance", due_date="2026-12-01")
    assert memory_only.status_code == 201
    assert response_one_time(memory_only, "one_annual_insurance")


def test_delete_committed_purchase_is_the_undo():
    committed = client.post(
        "/twin/alex/purchases/commit",
        json={
            "events": [
                {
                    "type": "purchase",
                    "description": "Laptop",
                    "amount": 800,
                    "date": "2026-09-20",
                    "account_id": "acc_checking",
                }
            ],
            "goal_updates": [],
        },
    )
    assert committed.status_code == 200
    [obligation_id] = committed.json()["created_ids"]

    deleted = client.delete(f"/twin/alex/obligations/one-time/{obligation_id}")

    assert deleted.status_code == 200
    assert all(
        obligation["id"] != obligation_id
        for obligation in deleted.json()["one_time_obligations"]
    )


def test_one_time_writes_keep_the_exact_unknown_user_404():
    response = client.post(
        "/twin/nobody/obligations/one-time",
        json={
            "name": "Tuition",
            "amount": 400,
            "due_date": "2026-10-15",
            "account_id": "acc_checking",
        },
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "No twin for user 'nobody'"}
