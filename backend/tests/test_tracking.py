import pytest
from fastapi.testclient import TestClient

from backend import main, twin_source
from backend.fixtures import load_raw_transactions, load_twin
from backend.ingest.build import latest_transaction_date, rebuild
from backend.ingest.normalize import normalize_all
from backend.nessie.client import NessieError
from backend.tracking import log_twin_build, twin_build_summary

PARAM_KEYS = {
    "user_id",
    "source",
    "method",
    "as_of",
    "window_start",
    "observed_fortnights",
    "half_life_days",
}


def built_twin():
    """Alex rebuilt from transactions.json, through the last transaction."""
    transactions = normalize_all(load_raw_transactions())
    return rebuild(load_twin(), transactions, latest_transaction_date(transactions))


def test_built_twin_params_describe_the_forecast():
    params, _ = twin_build_summary(built_twin())
    assert params == {
        "user_id": "alex",
        "source": "none",
        "method": "seasonal_ewma",
        "as_of": "2026-09-18",
        "window_start": "2025-09-20",
        "observed_fortnights": "25",
        "half_life_days": "180.0",
    }


def test_built_twin_metrics_match_its_seasonal_profiles():
    twin = built_twin()
    _, metrics = twin_build_summary(twin)
    seasonal = [v for v in twin.variable_spending if v.seasonal is not None]
    assert seasonal
    for spending in seasonal:
        factors = spending.seasonal.factors.values()
        assert metrics[f"{spending.category}.seasonal_max"] == max(factors) > 1
        assert metrics[f"{spending.category}.seasonal_min"] == min(factors) < 1
    for spending in twin.variable_spending:
        assert metrics[f"{spending.category}.mean_14d"] == spending.mean_14d
        assert metrics[f"{spending.category}.std_dev_14d"] == spending.std_dev_14d
    assert metrics["income_streams"] == len(twin.income)
    assert metrics["obligations"] == len(twin.obligations)


def test_flat_twin_has_no_seasonal_metrics(flat_twin):
    _, metrics = twin_build_summary(flat_twin)
    assert not [key for key in metrics if ".seasonal_" in key]
    assert f"{flat_twin.variable_spending[0].category}.mean_14d" in metrics


def test_twin_without_forecast_keeps_every_param():
    twin = load_twin().model_copy(update={"forecast": None})
    params, _ = twin_build_summary(twin)
    assert set(params) == PARAM_KEYS
    for key in PARAM_KEYS - {"user_id"}:
        assert params[key] == "none", key


def test_values_are_strings_and_floats(flat_twin):
    for twin in (built_twin(), flat_twin):
        params, metrics = twin_build_summary(twin)
        assert all(type(value) is str for value in params.values())
        assert all(type(value) is float for value in metrics.values())


class FakeLogRun:
    """Stands in for MLflow: records what would have been logged."""

    def __init__(self):
        self.runs = []

    def __call__(self, params, metrics):
        self.runs.append((params, metrics))


@pytest.mark.parametrize("value", [None, "", "false", "ture"])
def test_tracking_is_off_unless_explicitly_on(monkeypatch, flat_twin, value):
    if value is None:
        monkeypatch.delenv("TRACK_TWIN_BUILDS", raising=False)
    else:
        monkeypatch.setenv("TRACK_TWIN_BUILDS", value)
    fake = FakeLogRun()
    assert log_twin_build(flat_twin, log_run=fake) is False
    assert fake.runs == []


def test_tracking_on_logs_the_summary(monkeypatch, flat_twin):
    monkeypatch.setenv("TRACK_TWIN_BUILDS", "true")
    fake = FakeLogRun()
    assert log_twin_build(flat_twin, log_run=fake) is True
    assert fake.runs == [twin_build_summary(flat_twin)]


def test_tracking_failure_does_not_raise(monkeypatch, flat_twin):
    monkeypatch.setenv("TRACK_TWIN_BUILDS", "true")

    def broken(params, metrics):
        raise ConnectionError("tracking server unreachable")

    assert log_twin_build(flat_twin, log_run=broken) is False


# --- Where builds are logged --------------------------------------------------


@pytest.fixture
def logged(monkeypatch):
    """Replace log_twin_build at every call site with a recorder."""
    twins = []
    for module in (main, twin_source):
        monkeypatch.setattr(module, "log_twin_build", twins.append)
    return twins


def use_nessie(monkeypatch):
    monkeypatch.setenv("USE_MOCKS", "false")
    monkeypatch.setenv("NESSIE_API_KEY", "secret-key")


def test_the_build_endpoint_logs_the_twin_it_returns(logged):
    response = TestClient(main.app).post("/twin/build", json={"user_id": "alex"})
    assert response.status_code == 200, response.text
    assert [twin.model_dump(mode="json") for twin in logged] == [response.json()]


def test_serving_the_fixture_twin_logs_nothing(logged):
    assert TestClient(main.app).get("/twin/alex").status_code == 200
    assert logged == []


def test_a_nessie_build_is_logged_once_per_build(monkeypatch, logged):
    use_nessie(monkeypatch)
    built = load_twin().model_copy(update={"source": "nessie"})
    monkeypatch.setattr(twin_source, "build_from_nessie", lambda config: built)
    twin_source.load_source_twin()
    twin_source.load_source_twin()  # served from the cache
    assert logged == [built]


def test_a_nessie_outage_logs_nothing(monkeypatch, logged):
    use_nessie(monkeypatch)

    def outage(config):
        raise NessieError("sandbox unreachable")

    monkeypatch.setattr(twin_source, "build_from_nessie", outage)
    assert twin_source.load_source_twin().source == "fixture"
    assert logged == []


def test_a_tracking_failure_does_not_break_the_build_endpoint(monkeypatch):
    """The real log_twin_build, switched on, with MLflow failing underneath it."""
    monkeypatch.setenv("TRACK_TWIN_BUILDS", "true")

    def broken(params, metrics):
        raise ConnectionError("tracking server unreachable")

    real = main.log_twin_build
    monkeypatch.setattr(main, "log_twin_build", lambda twin: real(twin, log_run=broken))
    response = TestClient(main.app).post("/twin/build", json={"user_id": "alex"})
    assert response.status_code == 200, response.text
