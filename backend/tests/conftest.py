import pytest

from backend import simulation_store, twin_source, twin_store


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
