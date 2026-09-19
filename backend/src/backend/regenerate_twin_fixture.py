"""Regenerate backend/fixtures/twin.json by rebuilding it from the mock feed.

`twin.json` is what the app serves and what `/insights` explains. It used to be
hand-written, which meant it could claim figures no detector had produced: a
mean, a spread and a seasonal shape that nothing was fitted to. That is exactly
the provenance problem the Forecast & Data page exists to prevent, and it is why
this script exists.

The fixtures now have one direction. `twin_seed.json` is the hand-written input;
`ingest.generate_transactions` turns it into a year of statement rows; this
rebuilds a twin from those rows. Run them in that order after changing either:

    cd backend
    uv run python -m backend.ingest.generate_transactions   # only if the seed changed
    uv run python -m backend.regenerate_twin_fixture
    uv run python -m backend.regenerate_simulation_fixture
    uv run python -m backend.sync_frontend_mocks

Only the observed half is rebuilt. Identity, balances, goals and constraints
come from the seed and pass through untouched, because no transaction history
can produce them (SPEC section 2).

`as_of` is the last day the feed covers, not today and not the seed's own
`as_of`. The two differ by a day, and that day matters: the feed ends on
2026-09-18 after exactly 26 fortnights, so dating the twin 2026-09-19 opens a
27th block holding a single day, which the fitter counts as a whole fortnight of
near-zero spending. A twin must never describe a stretch it has not observed.
"""

import json
from pathlib import Path

from backend.fixtures import FIXTURES_DIR, load_raw_transactions, load_seed_twin
from backend.ingest import normalize_all
from backend.ingest.build import latest_transaction_date, rebuild
from backend.schemas import FinancialTwin


def build() -> FinancialTwin:
    """The canonical fixture twin. Deterministic: same feed, same bytes."""
    transactions = normalize_all(load_raw_transactions())
    as_of = latest_transaction_date(transactions)
    if as_of is None:
        raise ValueError("the transaction fixture is empty, so there is nothing to rebuild from")
    return rebuild(load_seed_twin(), transactions, as_of)


def write() -> Path:
    path = FIXTURES_DIR / "twin.json"
    payload = json.dumps(build().model_dump(mode="json"), indent=2, ensure_ascii=False)
    path.write_text(payload + "\n")
    return path


if __name__ == "__main__":
    print(f"wrote {write()}")
