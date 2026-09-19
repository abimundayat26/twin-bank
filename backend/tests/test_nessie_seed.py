"""Seeding Alex into Nessie.

No network and no writes: a MockTransport records what the seeder would POST.
What is worth testing here is not that httpx works, but that the right thing
goes into the sandbox — the fixture's own balances and its own transactions,
each to the endpoint Nessie expects for its kind.
"""

import httpx
import pytest

from backend.fixtures import load_raw_transactions, load_twin
from backend.nessie.client import NessieError
from backend.nessie.seed import (
    MERCHANT,
    TYPE_TO_KIND,
    Seeder,
    customer_name,
    main,
    seed,
    transaction_payload,
)

CREATED = {"code": 201, "message": "Created", "objectCreated": {"_id": "new_id"}}


class Recorder:
    """Answers every Nessie call and remembers the writes."""

    def __init__(self, customers: list[dict] | None = None) -> None:
        self.customers = customers or []
        self.posts: list[tuple[str, dict]] = []
        self.ids = iter(f"nessie_{n}" for n in range(1, 1000))

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/customers":
            return httpx.Response(200, json=self.customers)
        import json

        body = json.loads(request.content) if request.content else {}
        self.posts.append((request.url.path, body))
        return httpx.Response(201, json={**CREATED, "objectCreated": {"_id": next(self.ids)}})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def paths_ending(self, suffix: str) -> list[tuple[str, dict]]:
        return [(path, body) for path, body in self.posts if path.endswith(suffix)]


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    """Point every Seeder at the recorder instead of the network."""
    recorder = Recorder()
    original = Seeder.__init__

    def patched(self, api_key: str, base_url: str = "https://nessie.test") -> None:
        original(self, api_key, base_url)
        self.client = httpx.Client(transport=recorder.transport())

    monkeypatch.setattr(Seeder, "__init__", patched)
    return recorder


# --- What gets posted ---------------------------------------------------------


def test_a_purchase_uses_purchase_date() -> None:
    """Nessie dates purchases differently, and the seeder has to match."""
    purchase = next(r for r in load_raw_transactions() if r.type == "purchase")
    kind, body = transaction_payload(purchase, "merchant_1")
    assert kind == "purchases"
    assert body["purchase_date"] == purchase.transaction_date.isoformat()
    assert "transaction_date" not in body
    assert body["merchant_id"] == "merchant_1"


def test_a_deposit_uses_transaction_date() -> None:
    deposit = next(r for r in load_raw_transactions() if r.type == "deposit")
    kind, body = transaction_payload(deposit, "merchant_1")
    assert kind == "deposits"
    assert body["transaction_date"] == deposit.transaction_date.isoformat()
    assert "merchant_id" not in body


def test_an_outgoing_transfer_is_recorded_as_money_leaving() -> None:
    """Nessie has no matching transfer concept; what we know is that it left.

    Recording it as a withdrawal keeps the cash flow honest without claiming the
    transfer was savings or a repayment.
    """
    assert TYPE_TO_KIND["transfer"] == "withdrawals"


def test_amounts_and_descriptions_survive() -> None:
    raw = load_raw_transactions()[0]
    _, body = transaction_payload(raw, "merchant_1")
    assert body["amount"] == raw.amount
    assert body["description"] == raw.description
    assert body["status"] == raw.status


# --- The whole run ------------------------------------------------------------


def test_seeding_creates_the_customer_accounts_and_feed(recorder: Recorder) -> None:
    twin, raws = load_twin(), load_raw_transactions()
    accounts = seed("secret-key", "https://nessie.test", force=False, pause=0)

    assert len(recorder.paths_ending("/customers")) == 1
    assert len(recorder.paths_ending("/accounts")) == len(twin.accounts)
    assert set(accounts) == {a.id for a in twin.accounts}

    transactions = [p for p, _ in recorder.posts if "/accounts/" in p and p.count("/") == 3]
    assert len(transactions) == len(raws)


def test_accounts_open_with_the_balances_on_file(recorder: Recorder) -> None:
    """Balances are reported by the bank; the fixture is standing in for one."""
    seed("secret-key", "https://nessie.test", force=False, pause=0)
    posted = {body["nickname"]: body for _, body in recorder.paths_ending("/accounts")}
    for account in load_twin().accounts:
        assert posted[account.name]["balance"] == account.balance
        assert posted[account.name]["type"] == account.type.title()


def test_every_transaction_lands_on_a_created_account(recorder: Recorder) -> None:
    accounts = set(seed("secret-key", "https://nessie.test", force=False, pause=0).values())
    for path, _ in recorder.posts:
        if "/accounts/" in path and path.count("/") == 3:
            assert path.split("/")[2] in accounts


def test_seeding_twice_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """Re-running would leave two Alexes and make the account ids ambiguous."""
    first, last = customer_name(load_twin())
    recorder = Recorder(customers=[{"_id": "existing", "first_name": first, "last_name": last}])
    original = Seeder.__init__

    def patched(self, api_key: str, base_url: str = "https://nessie.test") -> None:
        original(self, api_key, base_url)
        self.client = httpx.Client(transport=recorder.transport())

    monkeypatch.setattr(Seeder, "__init__", patched)

    with pytest.raises(NessieError, match="already exists"):
        seed("secret-key", "https://nessie.test", force=False, pause=0)
    assert recorder.posts == []

    seed("secret-key", "https://nessie.test", force=True, pause=0)
    assert recorder.posts


# --- Failure and safety -------------------------------------------------------


def test_without_a_key_it_refuses(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    monkeypatch.delenv("NESSIE_API_KEY", raising=False)
    assert main([]) == 1
    assert "NESSIE_API_KEY" in capsys.readouterr().err


def test_a_rejected_write_does_not_leak_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    def reject(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text=f"bad key {request.url}")

    original = Seeder.__init__

    def patched(self, api_key: str, base_url: str = "https://nessie.test") -> None:
        original(self, api_key, base_url)
        self.client = httpx.Client(transport=httpx.MockTransport(reject))

    monkeypatch.setattr(Seeder, "__init__", patched)

    with pytest.raises(NessieError) as caught:
        seed("secret-key", "https://nessie.test", force=False, pause=0)
    assert "secret-key" not in str(caught.value)


def test_merchant_category_is_a_string() -> None:
    # Nessie answered a list with "category: str type expected" (400).
    assert isinstance(MERCHANT["category"], str)
