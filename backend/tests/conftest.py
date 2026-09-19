import pytest

from backend import simulation_store, twin_source, twin_store


@pytest.fixture(autouse=True)
def reset_twin_store():
    """User answers, stored simulations and the cached twin are process-wide, so
    clear them around every test."""
    for module in (twin_store, simulation_store, twin_source):
        module.reset()
    yield
    for module in (twin_store, simulation_store, twin_source):
        module.reset()
