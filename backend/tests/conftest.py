import pytest

from backend import twin_store


@pytest.fixture(autouse=True)
def reset_twin_store():
    """User answers are process-wide, so clear them around every test."""
    twin_store.reset()
    yield
    twin_store.reset()
