"""The offline simulation fixture must be something the engine would really produce."""

import json

from backend.fixtures import FIXTURES_DIR
from backend.regenerate_simulation_fixture import build


def test_fixture_is_the_generator_output():
    """Fails when an engine change moves the numbers but the fixture is not regenerated.

    Fix by running: uv run python -m backend.regenerate_simulation_fixture
    """
    committed = json.loads((FIXTURES_DIR / "simulation.json").read_text())
    assert committed == build().model_dump(mode="json")


def test_fixture_is_marked_as_a_mock():
    fixture = build()
    assert fixture.is_mock is True
    assert "Precomputed result" in fixture.assumptions[0]
