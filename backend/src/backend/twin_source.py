"""Where a twin's observed half comes from: the fixture, Nessie, or Databricks.

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

Databricks, when configured, wins over Nessie: pointing the backend at a twin
the Databricks job built (`DATABRICKS_TWIN_PATH`) is the more specific ask. That
twin was built elsewhere, so it is served as read, and recording its build was
the job's business, not this module's.

The twin is cached. `get_twin()` runs on every twin request and again inside
`/simulate` and `/optimize`; without a cache each of those would be a fresh
round trip to a rate-limited sandbox.
"""

import logging
import time

from backend.databricks_twin import DatabricksConfig, DatabricksError, fetch_twin
from backend.databricks_twin import load_config as load_databricks_config
from backend.fixtures import load_twin
from backend.ingest.build import latest_transaction_date, rebuild
from backend.ingest.normalize import normalize_all
from backend.nessie.client import NessieError, fetch_accounts, fetch_transactions
from backend.nessie.config import NessieConfig, load_config
from backend.schemas import FinancialTwin
from backend.tracking import log_twin_build

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
    twin = rebuild(carried, [t for t in transactions if t.date <= as_of], as_of)
    return twin.model_copy(update={"source": "nessie"})


def from_databricks(config: DatabricksConfig) -> FinancialTwin:
    """The twin the Databricks job built, with our declared data.

    The job rebuilt an uploaded copy of the twin on file, but anything fetched is
    still fetched: identity, goals and constraints come from the fixture, as they
    do for Nessie. Only the observed half and balances are taken from the file.
    """
    built = fetch_twin(config)
    on_file = load_twin()
    if built.user_id != on_file.user_id:
        raise DatabricksError(
            f"{config.twin_path} holds {built.user_id!r}'s twin, not {on_file.user_id!r}'s"
        )
    return built.model_copy(
        update={
            "display_name": on_file.display_name,
            "goals": on_file.goals,
            "constraints": on_file.constraints,
            "source": "databricks",
        }
    )


def from_fixture() -> FinancialTwin:
    """The fixture twin, labelled as fixture-derived.

    Every branch of `load_source_twin` that serves the fixture goes through
    here, so a fallback can never be mistaken for live bank data.
    """
    return load_twin().model_copy(update={"source": "fixture"})


def load_source_twin() -> FinancialTwin:
    """The twin the rest of the app should work from.

    Returns the fixture whenever no source is configured or the configured one
    is unreachable, so the caller never has to handle a missing bank. Either way
    the twin carries the source it came from, so the UI can say which one it is
    showing.
    """
    global _cached

    databricks = load_databricks_config()
    config = load_config()
    if databricks is None and config is None:
        return from_fixture()

    if _cached is not None and time.monotonic() - _cached[0] < CACHE_SECONDS:
        return _cached[1]

    try:
        twin = from_databricks(databricks) if databricks else build_from_nessie(config)
    except (DatabricksError, NessieError) as e:
        # Loudly, and then carry on: a broken integration must not take the
        # demo down with it.
        logger.warning("Falling back to the fixture twin: %s", e)
        return from_fixture()

    _cached = (time.monotonic(), twin)
    # Once per build, not per request: a cache hit returned above.
    if databricks is None:
        log_twin_build(twin)
    return twin


def reset() -> None:
    """Forget the cached twin. Called between tests and after a reseed."""
    global _cached
    _cached = None
