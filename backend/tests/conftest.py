import pytest

from backend import assistant_store, simulation_store, twin_source, twin_store
from backend.fixtures import load_twin


@pytest.fixture(autouse=True)
def reset_twin_store(tmp_path, monkeypatch):
    """User answers, stored simulations, assistant drafts and the cached twin are
    process-wide, so clear them around every test. Saved answers go to a temporary
    file, never the repo."""
    monkeypatch.setattr(twin_store, "answers_path", tmp_path / "answers.json")
    for module in (twin_store, simulation_store, twin_source, assistant_store):
        module.reset()
    yield
    for module in (twin_store, simulation_store, twin_source, assistant_store):
        module.reset()


@pytest.fixture(autouse=True)
def no_real_llm(monkeypatch):
    """A developer's shell may export a real key; tests must never call Claude."""
    for name in ("GOAL_COMPILER", "ANTHROPIC_API_KEY", "LLM_MODEL"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def no_real_tracking(monkeypatch):
    """A developer's shell may turn tracking on; tests must never write MLflow runs."""
    monkeypatch.delenv("TRACK_TWIN_BUILDS", raising=False)


@pytest.fixture(autouse=True)
def no_real_databricks(monkeypatch):
    """A developer's shell may point at a workspace; tests must never call Databricks."""
    for name in ("DATABRICKS_TWIN_PATH", "DATABRICKS_HOST", "DATABRICKS_TOKEN"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def flat_twin():
    """Alex's fixture twin with its seasonal profiles and forecast removed.

    For tests whose arithmetic is worked out by hand against flat 14-day averages,
    so they keep checking the engine rather than the fixture's seasonal shape.

    The forecast goes with the profiles. It records `method="seasonal_ewma"`, and
    a twin claiming a seasonal method while carrying no seasonal profile would
    describe an estimate that is not the one on it. A test that wants the
    metadata back adds it explicitly.
    """
    twin = load_twin()
    flat = [v.model_copy(update={"seasonal": None}) for v in twin.variable_spending]
    return twin.model_copy(update={"variable_spending": flat, "forecast": None})
