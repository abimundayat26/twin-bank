"""Capital One Nessie integration (SPEC Phase 3).

Replaces where raw banking events come from, not what they are: the client
returns `RawTransaction`, the same shape `fixtures.load_raw_transactions()`
produces, so everything downstream is unchanged.

Off by default. With no `NESSIE_API_KEY`, `load_config()` returns None and the
fixtures stay in charge, so a fresh clone runs the demo with no credentials.
"""

from backend.nessie.client import NessieError, fetch_accounts, fetch_transactions
from backend.nessie.config import NessieConfig, load_config, use_mocks

__all__ = [
    "NessieConfig",
    "NessieError",
    "fetch_accounts",
    "fetch_transactions",
    "load_config",
    "use_mocks",
]
