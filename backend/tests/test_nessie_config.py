"""Nessie configuration, and the rule that mocks win by default.

CLAUDE.md: a fresh clone with no credentials must run the whole demo. Every
test here is really the same assertion from a different angle — you have to
ask for Nessie explicitly, and asking badly gets you the fixtures, not a crash.
"""

import pytest

from backend.nessie.config import DEFAULT_BASE_URL, load_config, use_mocks

NESSIE_VARS = ("USE_MOCKS", "NESSIE_API_KEY", "NESSIE_ACCOUNT_IDS", "NESSIE_BASE_URL")


@pytest.fixture(autouse=True)
def clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start from a machine that has never heard of Nessie."""
    for name in NESSIE_VARS:
        monkeypatch.delenv(name, raising=False)


def enable(monkeypatch: pytest.MonkeyPatch, **env: str) -> None:
    monkeypatch.setenv("USE_MOCKS", "false")
    monkeypatch.setenv("NESSIE_API_KEY", "secret-key")
    for name, value in env.items():
        monkeypatch.setenv(name, value)


def test_a_fresh_clone_uses_mocks() -> None:
    assert use_mocks() is True
    assert load_config() is None


def test_mocks_stay_on_even_with_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """USE_MOCKS is the switch. A key lying around does not flip it."""
    monkeypatch.setenv("NESSIE_API_KEY", "secret-key")
    assert load_config() is None


def test_turning_mocks_off_without_a_key_still_uses_mocks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A client with no credentials cannot fetch, so this is not a usable config."""
    monkeypatch.setenv("USE_MOCKS", "false")
    assert load_config() is None


def test_a_blank_key_is_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """`.env` written from `.env.example` has `NESSIE_API_KEY=` sitting there empty."""
    monkeypatch.setenv("USE_MOCKS", "false")
    monkeypatch.setenv("NESSIE_API_KEY", "   ")
    assert load_config() is None


def test_a_configured_client(monkeypatch: pytest.MonkeyPatch) -> None:
    enable(monkeypatch)
    config = load_config()
    assert config is not None
    assert config.api_key == "secret-key"
    assert config.base_url == DEFAULT_BASE_URL


def test_the_default_base_url_is_https() -> None:
    """Verified 2026-09-19: the documented http:// host refuses connections."""
    assert DEFAULT_BASE_URL.startswith("https://")


def test_account_ids_are_split_and_trimmed(monkeypatch: pytest.MonkeyPatch) -> None:
    enable(monkeypatch, NESSIE_ACCOUNT_IDS=" acc_1 , acc_2 ,, ")
    config = load_config()
    assert config is not None
    assert config.account_ids == ("acc_1", "acc_2")


def test_a_trailing_slash_on_the_base_url_does_not_double_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enable(monkeypatch, NESSIE_BASE_URL="https://nessie.test/")
    config = load_config()
    assert config is not None
    assert config.base_url == "https://nessie.test"


@pytest.mark.parametrize("value", ["false", "0", "no", "off", "FALSE"])
def test_ways_of_saying_no(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("USE_MOCKS", value)
    assert use_mocks() is False


@pytest.mark.parametrize("value", ["true", "1", "yes", "on", "", "nonsense"])
def test_anything_else_leaves_mocks_on(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    """Unrecognised means mocks, because the safe direction is the demo working."""
    monkeypatch.setenv("USE_MOCKS", value)
    assert use_mocks() is True
