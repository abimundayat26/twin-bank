"""The Nessie read-back check.

No network. `build_from_nessie` runs for real, with its two fetches answered
from the fixtures, so the whole read-back path is exercised offline; what is
under test is the checker's judgement, not httpx.
"""

import pytest

from backend import twin_source
from backend.fixtures import load_raw_transactions, load_twin
from backend.nessie import readback
from backend.nessie.client import NessieError
from backend.nessie.config import NessieConfig
from backend.nessie.readback import compare


@pytest.fixture
def read_back(monkeypatch) -> twin_source.FinancialTwin:
    """Alex as build_from_nessie would see him, if Nessie held exactly the mock feed."""
    monkeypatch.setattr(twin_source, "fetch_accounts", lambda config: load_twin().accounts)
    monkeypatch.setattr(
        twin_source, "fetch_transactions", lambda config, ids: load_raw_transactions()
    )
    return twin_source.build_from_nessie(NessieConfig(api_key="test-key"))


def test_the_mock_feed_read_back_is_recognisable(read_back) -> None:
    assert compare(read_back, load_twin()) == []


def test_a_fixture_fallback_does_not_pass_as_nessie(read_back) -> None:
    fallback = read_back.model_copy(update={"source": "fixture"})
    assert any("source" in p for p in compare(fallback, load_twin()))


def test_a_moved_rent_day_is_caught(read_back) -> None:
    obligations = [
        o.model_copy(update={"due_day": 3}) if o.due_day == 1 else o
        for o in read_back.obligations
    ]
    moved = read_back.model_copy(update={"obligations": obligations})
    problems = compare(moved, load_twin())
    assert any("day 1" in p for p in problems)
    assert any("day 3" in p for p in problems)


def test_a_wrong_paycheck_cadence_is_caught(read_back) -> None:
    income = [i.model_copy(update={"interval_days": 30}) for i in read_back.income]
    monthly = read_back.model_copy(update={"income": income})
    assert any("every 30 days" in p for p in compare(monthly, load_twin()))


def test_a_changed_goal_is_caught(read_back) -> None:
    goals = [g.model_copy(update={"target_amount": 999.0}) for g in read_back.goals]
    changed = read_back.model_copy(update={"goals": goals})
    assert "goals differ from the ones on file" in compare(changed, load_twin())


def test_a_missing_spending_category_is_caught(read_back) -> None:
    fewer = read_back.model_copy(update={"variable_spending": read_back.variable_spending[:1]})
    assert any("spending categories" in p for p in compare(fewer, load_twin()))


def test_a_twin_without_a_forecast_is_caught(read_back) -> None:
    unforecast = read_back.model_copy(update={"forecast": None})
    assert "the twin records no forecast" in compare(unforecast, load_twin())


def test_main_refuses_without_nessie_configured(monkeypatch) -> None:
    monkeypatch.delenv("USE_MOCKS", raising=False)
    assert readback.main() == 1


def test_main_reports_a_nessie_failure_instead_of_falling_back(monkeypatch) -> None:
    monkeypatch.setenv("USE_MOCKS", "false")
    monkeypatch.setenv("NESSIE_API_KEY", "test-key")

    def unreachable(config):
        raise NessieError("sandbox unreachable")

    monkeypatch.setattr(readback, "build_from_nessie", unreachable)
    assert readback.main() == 1
