"""Put Alex into the Nessie sandbox.

Nessie ships empty. Alex does not exist in it, so a read-only client has
nothing to read and Phase 3 has nothing to show. This script creates him, from
the fixtures we already have:

    fixtures/twin.json          -> a customer and his checking/savings accounts
    fixtures/transactions.json  -> a year of purchases, deposits and transfers

Reusing the generated feed rather than inventing a second dataset matters: the
structure recurrence detection is supposed to find is the structure that went
in, so a twin built from Nessie can be compared against the twin on file.

    cd backend
    NESSIE_API_KEY=... uv run python -m backend.nessie.seed

A developer script, like ingest/generate_transactions.py -- not part of the
app, never imported by it. It writes to a sandbox other people can read, so
Alex is synthetic and nothing here is a real person's data.
"""

import argparse
import os
import sys
import time

import httpx

from backend.fixtures import load_raw_transactions, load_twin
from backend.ingest.models import RawTransaction
from backend.nessie.client import NessieError, redact
from backend.nessie.config import DEFAULT_BASE_URL, DEFAULT_TIMEOUT_SECONDS
from backend.schemas import Account, FinancialTwin

# Which Nessie endpoint each raw type is created through. Nessie has no
# "withdrawal on an account you also own" concept that matches our transfers,
# so an outgoing transfer is recorded as a withdrawal: the money left, which is
# the fact the simulator needs. What it was *for* stays undeclared (SPEC §2).
TYPE_TO_KIND = {
    "purchase": "purchases",
    "deposit": "deposits",
    "withdrawal": "withdrawals",
    "transfer": "withdrawals",
}

# Nessie wants a merchant for a purchase. One stands in for all of them: the
# description carries the payee, and that is what the categorizer reads.
MERCHANT = {
    "name": "TwinBank Demo Merchant",
    "category": ["demo"],
    "address": {
        "street_number": "1",
        "street_name": "Demo",
        "city": "Blacksburg",
        "state": "VA",
        "zip": "24060",
    },
    "geocode": {"lat": 37.2296, "lng": -80.4139},
}

ADDRESS = {
    "street_number": "1",
    "street_name": "Demo",
    "city": "Blacksburg",
    "state": "VA",
    "zip": "24060",
}

# Nessie is a shared sandbox on a small instance; 300+ sequential POSTs will
# trip it if fired flat out.
PAUSE_SECONDS = 0.05


class Seeder:
    """A thin POST/GET wrapper that keeps the key out of its own error messages."""

    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.client = httpx.Client(timeout=DEFAULT_TIMEOUT_SECONDS)

    def request(self, method: str, path: str, payload: dict | None = None) -> object:
        try:
            response = self.client.request(
                method, f"{self.base_url}{path}", params={"key": self.api_key}, json=payload
            )
        except httpx.HTTPError as e:
            raise NessieError(
                f"Could not reach Nessie at {path}: {redact(str(e), self.api_key)}"
            ) from e
        if response.status_code >= 400:
            raise NessieError(
                f"Nessie returned {response.status_code} for {method} {path}: "
                f"{redact(response.text, self.api_key)[:200]}"
            )
        return response.json() if response.content else None

    def created_id(self, body: object) -> str:
        """Nessie wraps creations as {"code":201,"message":...,"objectCreated":{...}}."""
        if isinstance(body, dict):
            created = body.get("objectCreated")
            if isinstance(created, dict) and created.get("_id"):
                return str(created["_id"])
            if body.get("_id"):
                return str(body["_id"])
        raise NessieError(f"Nessie did not return a created object: {str(body)[:200]}")

    def close(self) -> None:
        self.client.close()


def customer_name(twin: FinancialTwin) -> tuple[str, str]:
    """The twin's display name as Nessie's two fields.

    One function, because the name we create under and the name we search for
    have to agree: derive them separately and the duplicate check silently
    stops working.
    """
    first, _, last = twin.display_name.partition(" ")
    return first or "Alex", last or "Demo"


def existing_customer(seeder: Seeder, first: str, last: str) -> str | None:
    """The id of a customer already named this, if there is one."""
    customers = seeder.request("GET", "/customers")
    if not isinstance(customers, list):
        return None
    for customer in customers:
        if customer.get("first_name") == first and customer.get("last_name") == last:
            return str(customer["_id"])
    return None


def create_customer(seeder: Seeder, twin: FinancialTwin) -> str:
    first, last = customer_name(twin)
    return seeder.created_id(
        seeder.request(
            "POST",
            "/customers",
            {"first_name": first, "last_name": last, "address": ADDRESS},
        )
    )


def create_account(seeder: Seeder, customer_id: str, account: Account) -> str:
    """One account, opened with the balance the twin reports."""
    return seeder.created_id(
        seeder.request(
            "POST",
            f"/customers/{customer_id}/accounts",
            {
                "type": account.type.title(),
                "nickname": account.name,
                "rewards": 0,
                "balance": account.balance,
            },
        )
    )


def create_merchant(seeder: Seeder) -> str:
    return seeder.created_id(seeder.request("POST", "/merchants", MERCHANT))


def transaction_payload(raw: RawTransaction, merchant_id: str) -> tuple[str, dict]:
    """The endpoint and body for one raw transaction."""
    kind = TYPE_TO_KIND[raw.type]
    body: dict[str, object] = {
        "medium": "balance",
        "amount": raw.amount,
        "description": raw.description,
        "status": raw.status,
    }
    if kind == "purchases":
        body["merchant_id"] = merchant_id
        body["purchase_date"] = raw.transaction_date.isoformat()
    else:
        body["transaction_date"] = raw.transaction_date.isoformat()
    return kind, body


def seed(
    api_key: str, base_url: str, force: bool, pause: float = PAUSE_SECONDS
) -> dict[str, str]:
    """Create Alex, his accounts and his year of transactions. Returns account ids.

    `pause` throttles the 300-odd sequential POSTs; tests pass 0.
    """
    twin = load_twin()
    seeder = Seeder(api_key, base_url)
    try:
        found = existing_customer(seeder, *customer_name(twin))
        if found and not force:
            raise NessieError(
                f"A customer named {twin.display_name} already exists ({found}). "
                "Re-run with --force to create another."
            )

        customer_id = create_customer(seeder, twin)
        print(f"customer {twin.display_name}: {customer_id}")

        # Nessie account id -> our fixture id, so transactions land on the right one.
        accounts = {}
        for account in twin.accounts:
            accounts[account.id] = create_account(seeder, customer_id, account)
            print(f"  {account.type:<8} {account.name:<20} {accounts[account.id]}")

        merchant_id = create_merchant(seeder)
        checking = next(a.id for a in twin.accounts if a.type == "checking")

        raws = load_raw_transactions()
        print(f"\nposting {len(raws)} transactions...")
        posted = 0
        for raw in raws:
            account_id = accounts.get(raw.account_id, accounts[checking])
            kind, body = transaction_payload(raw, merchant_id)
            seeder.request("POST", f"/accounts/{account_id}/{kind}", body)
            posted += 1
            if posted % 50 == 0:
                print(f"  {posted}/{len(raws)}")
            if pause:
                time.sleep(pause)
        print(f"  {posted}/{len(raws)} done")
        return accounts
    finally:
        seeder.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed Alex into the Nessie sandbox.")
    parser.add_argument(
        "--force", action="store_true", help="Create Alex again even if he already exists."
    )
    parser.add_argument("--base-url", default=os.getenv("NESSIE_BASE_URL") or DEFAULT_BASE_URL)
    args = parser.parse_args(argv)

    api_key = (os.getenv("NESSIE_API_KEY") or "").strip()
    if not api_key:
        print("NESSIE_API_KEY is not set. Get a key at http://api.nessieisreal.com", file=sys.stderr)
        return 1

    print("This writes to a shared public sandbox. Alex is synthetic; do not seed real data.\n")
    try:
        accounts = seed(api_key, args.base_url, args.force)
    except NessieError as e:
        print(f"\nSeeding failed: {e}", file=sys.stderr)
        return 1

    print("\nAdd this to .env:\n")
    print(f"NESSIE_ACCOUNT_IDS={','.join(accounts.values())}")
    print("USE_MOCKS=false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
