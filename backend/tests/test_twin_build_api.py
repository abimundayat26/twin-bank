"""POST /twin/build — a twin computed from transactions instead of hand-written.

The demo must not depend on it. `GET /twin/alex` keeps serving the twin on file,
and building is a separate call whose result the caller can inspect.
"""

from datetime import date

from fastapi.testclient import TestClient

from backend.fixtures import load_twin
from backend.main import app
from backend.schemas import FinancialTwin, SimulationRequest
from backend.simulation import run_simulation

client = TestClient(app)


def build(**body) -> FinancialTwin:
    response = client.post("/twin/build", json={"user_id": "alex", **body})
    assert response.status_code == 200, response.text
    return FinancialTwin.model_validate(response.json())


def test_build_returns_a_twin_with_structure_in_it():
    twin = build()
    assert twin.user_id == "alex"
    assert twin.income and twin.obligations and twin.variable_spending


def test_built_structure_is_observed_and_unanswered():
    """Detection reports what it saw. It never fills in the user's answer."""
    twin = build()
    assert all(i.provenance == "observed" for i in twin.income)
    assert all(o.provenance == "observed" for o in twin.obligations)
    assert all(v.provenance == "observed" for v in twin.variable_spending)
    assert all(o.declared_category is None for o in twin.obligations)


def test_the_declared_half_survives_untouched():
    """Goals and constraints cannot be detected, so they are carried, not rebuilt."""
    on_file, built = load_twin(), build()
    assert built.goals == on_file.goals
    assert built.constraints == on_file.constraints


def test_balances_are_carried_from_the_accounts_on_file():
    on_file, built = load_twin(), build()
    assert built.accounts == on_file.accounts
    assert built.total_balance == on_file.total_balance


def test_supplied_balances_win():
    """Balances are reported by the bank, so the caller may pass fresher ones."""
    accounts = [{"id": "acc_checking", "name": "Everyday Checking", "type": "checking", "balance": 10}]
    twin = build(accounts=accounts)
    assert twin.total_balance == 10


def test_as_of_defaults_to_the_end_of_the_history():
    """The feed's last settled transaction is 2026-09-18; the two after it are pending."""
    assert build().as_of == date(2026, 9, 18)


def test_as_of_can_be_given():
    assert build(as_of="2026-09-19").as_of == date(2026, 9, 19)


def test_building_does_not_change_what_get_twin_serves():
    """Also the reason this endpoint has no UI entry point.

    A build returns a twin and stores nothing, so a "Rebuild" control could only
    show the user a twin the app is not using, or imply a refresh that did not
    happen. `frontend/SPEC.md` section 3.5 forbids the second outright. The
    decision to keep this backend-only is recorded in `main.build_twin` and in
    the README; if this assertion ever has to change, that decision is the thing
    to revisit, because the reasoning rests on it.
    """
    build()
    served = FinancialTwin.model_validate(client.get("/twin/alex").json())
    assert served == load_twin().model_copy(update={"source": "fixture"})


def test_unknown_user_is_not_found():
    assert client.post("/twin/build", json={"user_id": "nobody"}).status_code == 404


def test_a_built_twin_can_be_simulated():
    """The point of the feature: the built twin is a drop-in for the fixture."""
    twin = build()
    request = SimulationRequest.model_validate(
        {
            "user_id": "alex",
            "events": [
                {
                    "type": "purchase",
                    "description": "Laptop",
                    "amount": 800,
                    "date": twin.as_of.isoformat(),
                    "account_id": "acc_checking",
                }
            ],
        }
    )
    result = run_simulation(twin, request, n_simulations=50, seed=1)

    assert result.counterfactual.ending_balance < result.baseline.ending_balance
    assert result.summary


def test_a_past_as_of_ignores_later_transactions():
    """Building as of March must not use April onwards, or the next paycheck lands in September."""
    as_of = date(2026, 3, 1)
    twin = build(as_of=as_of.isoformat())
    assert twin.income
    for stream in twin.income:
        assert as_of < stream.next_date <= date.fromordinal(as_of.toordinal() + stream.interval_days)
