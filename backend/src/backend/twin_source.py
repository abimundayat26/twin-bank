"""Where a twin's observed half comes from: the fixture, or Nessie.

One decision, in one place, so `twin_store` does not have to know a network
exists. Everything it layers on top of the twin -- declared categories, the
minimum balance, goals, reserves -- is source-agnostic and unchanged.

Two rules shape this module:

* **Declared data is never fetched.** Goals and constraints come from the
  fixture even when the accounts and transactions come from Nessie. A bank
  knows what Alex spent; it cannot know he needs $2,000 by May (SPEC section 2).
* **An outage is not a failure.** If Nessie cannot be reached the fixture is
  served and a warning is logged, because "the demo should not fail completely
  because an external API is unavailable" (CLAUDE.md). This mirrors the rule
  the frontend already follows in `lib/api.ts`.

The twin is cached. `get_twin()` runs on every twin request and again inside
`/simulate` and `/optimize`; without a cache each of those would be a fresh
round trip to a rate-limited sandbox.
"""

import logging
import time

from backend.fixtures import load_twin
from backend.ingest.build import latest_transaction_date, rebuild
from backend.ingest.normalize import normalize_all
from backend.nessie.client import NessieError, fetch_accounts, fetch_transactions
from backend.nessie.config import NessieConfig, load_config
from backend.schemas import FinancialTwin

logger = logging.getLogger(__name__)

# Long enough that a demo click does not re-fetch, short enough that a reseed
# shows up without a restart.
CACHE_SECONDS = 300.0

_cached: tuple[float, FinancialTwin] | None = None


def build_from_nessie(config: NessieConfig) -> FinancialTwin:
    """A twin whose accounts and history are Nessie's, and whose goals are ours.

    Balances come from the accounts Nessie reports; a statement cannot produce
    them. `as_of` is the last day the history covers, and transactions after it
    are dropped so the twin never describes a future it has not observed.
    """
    accounts = fetch_accounts(config)
    raw = fetch_transactions(config, [account.id for account in accounts])
    transactions = normalize_all(raw)

    on_file = load_twin()
    as_of = latest_transaction_date(transactions) or on_file.as_of
    # Declared data and identity carry over; the observed half is rebuilt.
    carried = on_file.model_copy(update={"accounts": accounts})
    return rebuild(carried, [t for t in transactions if t.date <= as_of], as_of)


def load_source_twin() -> FinancialTwin:
    """The twin the rest of the app should work from.

    Returns the fixture whenever Nessie is off, unconfigured or unreachable, so
    the caller never has to handle a missing bank.
    """
    global _cached

    config = load_config()
    if config is None:
        return load_twin()

    if _cached is not None and time.monotonic() - _cached[0] < CACHE_SECONDS:
        return _cached[1]

    try:
        twin = build_from_nessie(config)
    except NessieError as e:
        # Loudly, and then carry on: a broken integration must not take the
        # demo down with it.
        logger.warning("Falling back to the fixture twin: %s", e)
        return load_twin()

    _cached = (time.monotonic(), twin)
    return twin


def reset() -> None:
    """Forget the cached twin. Called between tests and after a reseed."""
    global _cached
    _cached = None
