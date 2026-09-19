"""Serving the twin the Databricks job built. No test reaches a real workspace."""

import httpx
import pytest

from backend import twin_source
from backend.databricks_twin import (
    DatabricksConfig,
    DatabricksError,
    fetch_twin,
    load_config,
)
from backend.fixtures import load_twin

TOKEN = "test-token"
CONFIG = DatabricksConfig(
    host="https://workspace.example", token=TOKEN, twin_path="/Volumes/main/twinbank/data/twin.json"
)


def use_databricks(monkeypatch):
    monkeypatch.setenv("USE_MOCKS", "false")
    monkeypatch.setenv("DATABRICKS_HOST", "https://workspace.example")
    monkeypatch.setenv("DATABRICKS_TOKEN", TOKEN)
    monkeypatch.setenv("DATABRICKS_TWIN_PATH", "/Volumes/main/twinbank/data/twin.json")


def serving(body: str | bytes, status: int = 200, seen: list | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, content=body)

    return httpx.MockTransport(handler)


def built_twin_json(**update) -> str:
    """What the job writes: the twin on file, rebuilt. Here, the fixture itself."""
    return load_twin().model_copy(update=update).model_dump_json()


# --- Configuration ------------------------------------------------------------


def test_not_configured_by_default():
    assert load_config() is None


def test_mocks_on_keeps_databricks_off(monkeypatch):
    use_databricks(monkeypatch)
    monkeypatch.setenv("USE_MOCKS", "true")
    assert load_config() is None


@pytest.mark.parametrize("missing", ["DATABRICKS_HOST", "DATABRICKS_TOKEN", "DATABRICKS_TWIN_PATH"])
def test_every_setting_is_needed(monkeypatch, missing):
    use_databricks(monkeypatch)
    monkeypatch.delenv(missing)
    assert load_config() is None


def test_configured_with_everything_set(monkeypatch):
    use_databricks(monkeypatch)
    monkeypatch.setenv("DATABRICKS_HOST", "workspace.example/")
    assert load_config() == CONFIG


# --- Fetching -----------------------------------------------------------------


def test_fetch_reads_the_volume_file_with_the_token():
    seen = []
    twin = fetch_twin(CONFIG, serving(built_twin_json(), seen=seen))
    assert twin == load_twin()
    (request,) = seen
    assert str(request.url) == "https://workspace.example/api/2.0/fs/files/Volumes/main/twinbank/data/twin.json"
    assert request.headers["Authorization"] == f"Bearer {TOKEN}"


@pytest.mark.parametrize(
    "body, status, reason",
    [("", 404, "returned 404"), ("", 403, "returned 403"), ("{}", 200, "not a FinancialTwin")],
)
def test_fetch_failures_are_databricks_errors(body, status, reason):
    with pytest.raises(DatabricksError, match=reason):
        fetch_twin(CONFIG, serving(body, status))


def test_the_token_never_appears_in_an_error():
    def handler(request):
        raise httpx.ConnectError(f"refused, sent {TOKEN}")

    with pytest.raises(DatabricksError) as error:
        fetch_twin(CONFIG, httpx.MockTransport(handler))
    assert TOKEN not in str(error.value)


# --- Serving it ---------------------------------------------------------------


@pytest.fixture
def logged(monkeypatch):
    twins = []
    monkeypatch.setattr(twin_source, "log_twin_build", twins.append)
    return twins


def fetching(monkeypatch, body: str, status: int = 200):
    transport = serving(body, status)
    monkeypatch.setattr(twin_source, "fetch_twin", lambda config: fetch_twin(config, transport))


def test_a_databricks_twin_is_served_and_labelled(monkeypatch, logged):
    use_databricks(monkeypatch)
    fetching(monkeypatch, built_twin_json())
    twin = twin_source.load_source_twin()
    assert twin.source == "databricks"
    assert logged == [], "the job records its own builds"


def test_declared_data_is_never_taken_from_databricks(monkeypatch, logged):
    use_databricks(monkeypatch)
    fetching(monkeypatch, built_twin_json(goals=[], constraints=[], display_name="Someone"))
    twin = twin_source.load_source_twin()
    on_file = load_twin()
    assert (twin.goals, twin.constraints, twin.display_name) == (
        on_file.goals,
        on_file.constraints,
        on_file.display_name,
    )


def test_databricks_wins_over_nessie(monkeypatch, logged):
    use_databricks(monkeypatch)
    monkeypatch.setenv("NESSIE_API_KEY", "nessie-test-key")
    fetching(monkeypatch, built_twin_json())

    def nessie_called(config):
        raise AssertionError("Nessie must not be called when Databricks is configured")

    monkeypatch.setattr(twin_source, "build_from_nessie", nessie_called)
    assert twin_source.load_source_twin().source == "databricks"


@pytest.mark.parametrize(
    "body, status", [("", 503), ("{}", 200), (built_twin_json(user_id="someone_else"), 200)]
)
def test_a_bad_databricks_twin_falls_back_to_the_fixture(monkeypatch, caplog, body, status):
    use_databricks(monkeypatch)
    fetching(monkeypatch, body, status)
    assert twin_source.load_source_twin().source == "fixture"
    assert "Falling back to the fixture twin" in caplog.text
