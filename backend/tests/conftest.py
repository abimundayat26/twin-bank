import pytest

from backend import simulation_store, twin_source, twin_store
from backend.fixtures import load_twin


@pytest.fixture(autouse=True)
def reset_twin_store(tmp_path, monkeypatch):
    """User answers, stored simulations and the cached twin are process-wide, so
    clear them around every test. Saved answers go to a temporary file, never the repo."""
    monkeypatch.setattr(twin_store, "answers_path", tmp_path / "answers.json")
    for module in (twin_store, simulation_store, twin_source):
        module.reset()
    yield
    for module in (twin_store, simulation_store, twin_source):
        module.reset()


@pytest.fixture(autouse=True)
def no_real_llm(monkeypatch):
    """A developer's shell may export a real key; tests must never call Claude."""
    for name in ("GOAL_COMPILER", "ANTHROPIC_API_KEY", "LLM_MODEL"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def flat_twin():
    """Alex's fixture twin with its seasonal profiles removed.

    For tests whose arithmetic is worked out by hand against flat 14-day averages,
    so they keep checking the engine rather than the fixture's seasonal shape.
    """
    twin = load_twin()
    flat = [v.model_copy(update={"seasonal": None}) for v in twin.variable_spending]
    return twin.model_copy(update={"variable_spending": flat})
