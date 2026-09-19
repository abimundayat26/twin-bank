import pytest

from backend import simulation_store, twin_store


@pytest.fixture(autouse=True)
def reset_twin_store():
    """User answers and stored simulations are process-wide, so clear them around every test."""
    twin_store.reset()
    simulation_store.reset()
    yield
    twin_store.reset()
    simulation_store.reset()
