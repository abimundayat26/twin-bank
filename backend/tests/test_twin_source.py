"""Choosing between the fixture twin and a Nessie-built one.

The important assertions here are the defensive ones. This module decides what
the whole app believes about Alex's money, so the ways it can be wrong matter
more than the happy path: mocks must win unless someone opts out, an outage
must not take the demo down, and Nessie must never be able to invent a goal.
"""

import json

import httpx
import pytest

from backend import twin_source, twin_store
from backend.fixtures import FIXTURES_DIR, load_twin
from backend.nessie import client as nessie_client
from backend.nessie.config import NessieConfig
from backend.twin_source import build_from_nessie, load_source_twin

SAMPLES = json.loads((FIXTURES_DIR / "nessie_samples.json").read_text())
CONFIG = NessieConfig(api_key="secret-key", base_url="https://nessie.test")

CHECKING = {**SAMPLES["account"], "_id": "nessie_checking", "type": "Checking", "balance": 1000}
SAVINGS = {**SAMPLES["savings_account"], "_id": "nessie_savings", "type": "Savings", "balance": 500}


def paycheck(day: str, amount: float = 720.0) -> dict:
    return {
        "_id": f"dep_{day}",
        "transaction_date": day,
        "status": "completed",
        "amount": amount,
        "description": "CAMPUS BOOKSTORE PAYROLL",
    }


def rent(day: str) -> dict:
    return {
        "_id": f"wd_{day}",
        "type": "withdrawal",
        "transaction_date": day,
        "status": "completed",
        "amount": 650.0,
        "description": "HOKIE PROPERTY MGMT RENT",
    }


FORTNIGHTLY = [paycheck(f"2026-0{m}-{d:02d}") for m, d in ((3, 6), (3, 20), (4, 3), (4, 17), (5, 1), (5, 15), (5, 29), (6, 12))]
MONTHLY_RENT = [rent(f"2026-0{m}-01") for m in (2, 3, 4, 5, 6)]


def nessie(accounts: list[dict], deposits: list[dict], withdrawals: list[dict]):
    """A transport standing in for a seeded sandbox."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/accounts":
            return httpx.Response(200, json=accounts)
        if path.endswith("/deposits"):
            return httpx.Response(200, json=deposits if "checking" in path else [])
        if path.endswith("/withdrawals"):
            return httpx.Response(200, json=withdrawals if "checking" in path else [])
        return httpx.Response(200, json=[])

    return httpx.MockTransport(handler)


@pytest.fixture
def seeded(monkeypatch: pytest.MonkeyPatch):
    """Route every client call in twin_source through a fake sandbox."""
    transport = nessie([CHECKING, SAVINGS], FORTNIGHTLY, MONTHLY_RENT)
    monkeypatch.setattr(
        twin_source,
        "fetch_accounts",
        lambda config: nessie_client.fetch_accounts(config, transport),
    )
    monkeypatch.setattr(
        twin_source,
        "fetch_transactions",
        lambda config, ids: nessie_client.fetch_transactions(config, ids, transport),
    )
    return transport


def use_nessie(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USE_MOCKS", "false")
    monkeypatch.setenv("NESSIE_API_KEY", "secret-key")


# --- Which source wins --------------------------------------------------------


def test_a_fresh_clone_gets_the_fixture() -> None:
    assert load_source_twin() == load_twin()


def test_a_key_alone_does_not_switch_sources(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NESSIE_API_KEY", "secret-key")
    assert load_source_twin() == load_twin()


def test_nessie_is_used_when_asked_for(monkeypatch: pytest.MonkeyPatch, seeded) -> None:
    use_nessie(monkeypatch)
    twin = load_source_twin()
    assert twin != load_twin()
    assert [a.id for a in twin.accounts] == ["nessie_checking", "nessie_savings"]


# --- What Nessie is allowed to decide ----------------------------------------


def test_balances_come_from_nessie(seeded) -> None:
    """A statement cannot produce a balance; the bank reports it."""
    twin = build_from_nessie(CONFIG)
    assert twin.total_balance == 1500
    assert {a.type: a.balance for a in twin.accounts} == {"checking": 1000, "savings": 500}


def test_structure_is_detected_from_the_fetched_history(seeded) -> None:
    twin = build_from_nessie(CONFIG)
    (income,) = twin.income
    assert income.interval_days == 14
    assert income.expected_amount == pytest.approx(720, abs=1)
    assert any(o.due_day == 1 and o.expected_amount == 650 for o in twin.obligations)
    assert all(i.provenance == "observed" for i in twin.income)


def test_goals_and_constraints_are_never_fetched(seeded) -> None:
    """Nessie knows what Alex spent. It cannot know he needs $2,000 by May."""
    on_file, built = load_twin(), build_from_nessie(CONFIG)
    assert built.goals == on_file.goals
    assert built.constraints == on_file.constraints


def test_as_of_is_the_end_of_the_fetched_history(seeded) -> None:
    twin = build_from_nessie(CONFIG)
    assert twin.as_of.isoformat() == "2026-06-12"


def test_the_identity_is_kept(seeded) -> None:
    built = build_from_nessie(CONFIG)
    assert (built.user_id, built.display_name) == ("alex", load_twin().display_name)


# --- When Nessie is broken ----------------------------------------------------


def test_an_outage_falls_back_to_the_fixture(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """CLAUDE.md: the demo must not fail because an external API is down."""
    use_nessie(monkeypatch)

    def explode(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    transport = httpx.MockTransport(explode)
    monkeypatch.setattr(
        twin_source, "fetch_accounts", lambda config: nessie_client.fetch_accounts(config, transport)
    )

    with caplog.at_level("WARNING"):
        assert load_source_twin() == load_twin()
    assert "Falling back" in caplog.text


def test_a_bad_key_falls_back_rather_than_inventing_a_broke_alex(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unrecognised key answers 200 []. Believing it would show a $0 twin."""
    use_nessie(monkeypatch)
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=[]))
    monkeypatch.setattr(
        twin_source, "fetch_accounts", lambda config: nessie_client.fetch_accounts(config, transport)
    )
    assert load_source_twin() == load_twin()


def test_a_failure_is_not_cached(monkeypatch: pytest.MonkeyPatch, seeded) -> None:
    """A blip must not pin the app to the fixture until it restarts."""
    use_nessie(monkeypatch)
    calls = {"n": 0}
    working = twin_source.fetch_accounts

    def flaky(config):
        calls["n"] += 1
        if calls["n"] == 1:
            raise nessie_client.NessieError("temporary")
        return working(config)

    monkeypatch.setattr(twin_source, "fetch_accounts", flaky)
    assert load_source_twin() == load_twin()
    assert load_source_twin() != load_twin()


# --- Caching ------------------------------------------------------------------


def test_the_twin_is_fetched_once(monkeypatch: pytest.MonkeyPatch, seeded) -> None:
    """get_twin runs per request, and /simulate calls it too."""
    use_nessie(monkeypatch)
    calls = {"n": 0}
    working = twin_source.fetch_accounts

    def counted(config):
        calls["n"] += 1
        return working(config)

    monkeypatch.setattr(twin_source, "fetch_accounts", counted)
    for _ in range(5):
        load_source_twin()
    assert calls["n"] == 1


def test_reset_drops_the_cache(monkeypatch: pytest.MonkeyPatch, seeded) -> None:
    use_nessie(monkeypatch)
    load_source_twin()
    twin_source.reset()
    monkeypatch.setenv("USE_MOCKS", "true")
    assert load_source_twin() == load_twin()


# --- The answers layered on top still work -----------------------------------


def test_declared_answers_apply_to_a_nessie_twin(
    monkeypatch: pytest.MonkeyPatch, seeded
) -> None:
    """twin_store layers user answers on whatever twin it is given.

    The obligation ids are Nessie-derived, not the fixture's, so this would fail
    if the store still validated answers against the fixture.
    """
    use_nessie(monkeypatch)
    obligation = twin_store.get_twin().obligations[0]
    updated = twin_store.declare_category(obligation.id, "bill")
    assert next(o for o in updated.obligations if o.id == obligation.id).declared_category == "bill"
