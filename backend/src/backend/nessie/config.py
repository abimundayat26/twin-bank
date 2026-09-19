"""Where the Nessie client gets its settings.

Env is read inside functions, never at import time. `main.py` reads `os.getenv`
at module scope, which means a test that sets the variable after importing the
app has no effect; this module is deliberately friendlier to test and to the
`.env` file a developer edits while the server is already running.

Mocks are the default (CLAUDE.md, "External Integrations"): a fresh clone with
no credentials must run the whole demo, so every switch here fails towards the
fixtures rather than towards the network.
"""

import os
from dataclasses import dataclass

# Verified 2026-09-19: the documented http:// host refuses connections on port
# 80. Only HTTPS answers, so the scheme here is not interchangeable.
DEFAULT_BASE_URL = "https://api.nessieisreal.com"
DEFAULT_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class NessieConfig:
    api_key: str
    base_url: str = DEFAULT_BASE_URL
    account_ids: tuple[str, ...] = ()
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS


# Only an explicit "no" turns mocks off. A typo in .env is far likelier than a
# deliberate switch, and the safe direction is the demo still working.
MOCKS_OFF = frozenset({"0", "false", "no", "off"})


def use_mocks() -> bool:
    """True unless someone has explicitly turned mocks off."""
    return (os.getenv("USE_MOCKS") or "").strip().lower() not in MOCKS_OFF


def load_config() -> NessieConfig | None:
    """The configured client, or None when Nessie is not set up.

    None is the normal case, not an error: it means the fixtures are in charge.
    A missing key counts as not set up even if USE_MOCKS says otherwise, because
    a client without credentials cannot fetch anything.
    """
    if use_mocks():
        return None
    api_key = (os.getenv("NESSIE_API_KEY") or "").strip()
    if not api_key:
        return None
    account_ids = tuple(
        part.strip() for part in (os.getenv("NESSIE_ACCOUNT_IDS") or "").split(",") if part.strip()
    )
    return NessieConfig(
        api_key=api_key,
        base_url=(os.getenv("NESSIE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/"),
        account_ids=account_ids,
        timeout_seconds=float(os.getenv("NESSIE_TIMEOUT_SECONDS") or DEFAULT_TIMEOUT_SECONDS),
    )
