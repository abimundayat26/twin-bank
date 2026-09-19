"""Build a twin from a raw transaction file, as a batch job.

The same pipeline as `POST /twin/build` (normalize, detect, rebuild the on-file
twin), run from a file instead of a request, so that it can run where the data
lives. Phase 6 moves this processing into Databricks: there it runs as a Python
job over a transactions export, and here it runs the same way on the fixture.

    cd backend
    uv run python -m backend.build_job --transactions fixtures/transactions.json --out twin.json

The input is a JSON list in the raw shape of `fixtures/transactions.json`. The
output is one `FinancialTwin` as JSON. The job only computes the observed half:
identity, balances, goals and constraints come from the twin on file, exactly
as they do for the endpoint (SPEC section 2). With `TRACK_TWIN_BUILDS` on, the
build is recorded like any other.

A year of one person's transactions is a few hundred rows, so this is plain
Python rather than Spark. Nothing here reads the network. Nothing in the app
imports it.
"""

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from pydantic import ValidationError

from backend.fixtures import load_twin
from backend.ingest.build import latest_transaction_date, rebuild
from backend.ingest.models import RawTransaction
from backend.ingest.normalize import normalize_all
from backend.schemas import FinancialTwin
from backend.tracking import log_twin_build


class BuildJobError(Exception):
    """The input cannot produce a twin. The message says why, for the job log."""


def load_raw_transactions(path: Path) -> list[RawTransaction]:
    try:
        records = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise BuildJobError(f"Cannot read transactions from {path}: {e}") from e
    if not isinstance(records, list):
        raise BuildJobError(f"{path} must hold a JSON list of transactions")
    try:
        return [RawTransaction.model_validate(record) for record in records]
    except ValidationError as e:
        raise BuildJobError(f"{path} holds a transaction in an unknown shape: {e}") from e


def build(raw: list[RawTransaction], as_of: date | None = None) -> FinancialTwin:
    """The twin on file, with its observed half rebuilt from `raw`.

    Same rules as `POST /twin/build`: `as_of` defaults to the last transaction,
    and nothing after it is seen.
    """
    transactions = normalize_all(raw)
    as_of = as_of or latest_transaction_date(transactions)
    if as_of is None:
        raise BuildJobError("No settled transactions: there is no history to build from")
    return rebuild(load_twin(), [t for t in transactions if t.date <= as_of], as_of)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--transactions", type=Path, required=True, help="Raw transactions JSON")
    parser.add_argument("--out", type=Path, required=True, help="Where to write the twin JSON")
    parser.add_argument(
        "--as-of", type=date.fromisoformat, default=None, help="Defaults to the last transaction"
    )
    args = parser.parse_args(argv)

    try:
        twin = build(load_raw_transactions(args.transactions), args.as_of)
    except BuildJobError as e:
        print(e, file=sys.stderr)
        return 1

    args.out.write_text(twin.model_dump_json(indent=2) + "\n")
    log_twin_build(twin)
    print(f"Wrote {twin.user_id}'s twin as of {twin.as_of} to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
