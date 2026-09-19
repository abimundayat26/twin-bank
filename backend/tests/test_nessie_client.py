"""The Nessie client, against payloads recorded from the real API.

No network. `httpx.MockTransport` serves `fixtures/nessie_samples.json`, which
holds responses captured from api.nessieisreal.com on 2026-09-19 — so these
tests check the client against what Nessie actually returns rather than against
what we assumed it returns. Most of them exist because a specific quirk of that
payload would otherwise break us silently.
"""

import json

import httpx
import pytest

from backend.fixtures import FIXTURES_DIR
from backend.nessie.client import (
    UNKNOWN_DESCRIPTION,
    NessieError,
    fetch_accounts,
    fetch_transactions,
    redact,
    to_account,
    to_raw,
)
from backend.nessie.config import NessieConfig

SAMPLES = json.loads((FIXTURES_DIR / "nessie_samples.json").read_text())
CONFIG = NessieConfig(api_key="secret-key", base_url="https://nessie.test", timeout_seconds=1.0)

PURCHASE = SAMPLES["purchases"][0]
DEPOSIT = SAMPLES["deposits"][0]
WITHDRAWAL = SAMPLES["withdrawals"][0]
TRANSFER = SAMPLES["transfers"][0]
ACCOUNT = SAMPLES["account"]


def serve(routes: dict[str, object], record_calls: list[str] | None = None) -> httpx.MockTransport:
    """A transport answering by path, 404ing anything not listed."""

    def handler(request: httpx.Request) -> httpx.Response:
        if record_calls is not None:
            record_calls.append(request.url.path)
        if request.url.path not in routes:
            return httpx.Response(404, json="not found")
        return httpx.Response(200, json=routes[request.url.path])

    return httpx.MockTransport(handler)


def account_routes(account_id: str, **kinds) -> dict[str, object]:
    """The four transaction endpoints for one account, defaulting to empty."""
    return {
        f"/accounts/{account_id}/{kind}": kinds.get(kind, [])
        for kind in ("purchases", "deposits", "withdrawals", "transfers")
    }


# --- Mapping one record -------------------------------------------------------


def test_a_purchase_dates_from_purchase_date() -> None:
    """Purchases are the only kind without `transaction_date`."""
    assert "transaction_date" not in PURCHASE
    assert to_raw("purchases", "acc_1", PURCHASE).transaction_date.isoformat() == "2026-09-12"


def test_nessies_type_is_ignored() -> None:
    """A purchase says `"type": "merchant"`, which is not one of ours.

    The kind comes from the endpoint that returned the record; passing the
    payload's own value through would fail RawType validation.
    """
    assert PURCHASE["type"] == "merchant"
    assert to_raw("purchases", "acc_1", PURCHASE).type == "purchase"


def test_a_null_description_does_not_blow_up() -> None:
    """Nessie leaves purchase descriptions null; the categorizer needs a string."""
    assert PURCHASE["description"] is None
    assert to_raw("purchases", "acc_1", PURCHASE).description == UNKNOWN_DESCRIPTION


def test_a_supplied_description_wins() -> None:
    assert to_raw("purchases", "acc_1", PURCHASE, "KROGER #418").description == "KROGER #418"


def test_the_account_comes_from_the_path_not_the_record() -> None:
    """The record calls it `payer_id`, or omits it. We asked for an account; use that."""
    assert "account_id" not in PURCHASE
    assert to_raw("purchases", "acc_checking", PURCHASE).account_id == "acc_checking"
    assert to_raw("deposits", "acc_checking", DEPOSIT).account_id == "acc_checking"


@pytest.mark.parametrize(
    ("kind", "record", "expected"),
    [
        ("deposits", DEPOSIT, "deposit"),
        ("withdrawals", WITHDRAWAL, "withdrawal"),
        ("transfers", TRANSFER, "transfer"),
        ("purchases", PURCHASE, "purchase"),
    ],
)
def test_every_kind_maps(kind: str, record: dict, expected: str) -> None:
    raw = to_raw(kind, "acc_1", record)
    assert raw.type == expected
    assert raw.amount >= 0
    assert raw.id and raw.description


def test_a_negative_amount_is_made_unsigned() -> None:
    """RawTransaction requires ge=0; direction comes from the type."""
    assert to_raw("deposits", "acc_1", {**DEPOSIT, "amount": -320}).amount == 320


def test_a_record_with_no_date_is_an_error() -> None:
    with pytest.raises(NessieError, match="transaction_date"):
        to_raw("deposits", "acc_1", {k: v for k, v in DEPOSIT.items() if k != "transaction_date"})


def test_an_unknown_kind_is_an_error() -> None:
    with pytest.raises(NessieError, match="bills"):
        to_raw("bills", "acc_1", DEPOSIT)


# --- Accounts -----------------------------------------------------------------


def test_account_types_are_lowercased() -> None:
    assert ACCOUNT["type"] == "Checking"
    account = to_account(ACCOUNT)
    assert account is not None
    assert (account.type, account.balance, account.name) == ("checking", 4500, "Cuenta Rosa")


def test_an_account_we_cannot_simulate_is_skipped() -> None:
    """The engine moves cash between checking and savings; a credit line is not that."""
    assert to_account({**ACCOUNT, "type": "Credit Card"}) is None


def test_fetch_accounts_reads_the_listing() -> None:
    transport = serve({"/accounts": [ACCOUNT, SAMPLES["savings_account"]]})
    accounts = fetch_accounts(CONFIG, transport)
    assert [a.type for a in accounts] == ["checking", "savings"]


def test_an_empty_account_list_is_an_error_not_a_poor_customer() -> None:
    """A wrong key answers `200 []`. Believing it would invent a $0 twin."""
    with pytest.raises(NessieError, match="NESSIE_API_KEY"):
        fetch_accounts(CONFIG, serve({"/accounts": []}))


def test_configured_account_ids_are_fetched_directly() -> None:
    config = NessieConfig(api_key="k", base_url="https://nessie.test", account_ids=("acc_1",))
    transport = serve({"/accounts/acc_1": ACCOUNT})
    assert [a.id for a in fetch_accounts(config, transport)] == [ACCOUNT["_id"]]


# --- Fetching a feed ----------------------------------------------------------


def test_transactions_come_back_oldest_first() -> None:
    account = "acc_1"
    transport = serve(
        {
            **account_routes(
                account,
                purchases=[PURCHASE],
                deposits=[DEPOSIT],
                withdrawals=[WITHDRAWAL],
            ),
            "/merchants/" + PURCHASE["merchant_id"]: {"name": "KROGER #418"},
        }
    )
    feed = fetch_transactions(CONFIG, [account], transport)

    assert [t.transaction_date.isoformat() for t in feed] == [
        "2026-09-09",
        "2026-09-12",
        "2026-09-13",
    ]
    assert {t.type for t in feed} == {"deposit", "purchase", "withdrawal"}
    assert all(t.account_id == account for t in feed)


def test_a_missing_description_is_filled_from_the_merchant() -> None:
    """Without this every real purchase would categorize as "other"."""
    transport = serve(
        {
            **account_routes("acc_1", purchases=[PURCHASE]),
            "/merchants/" + PURCHASE["merchant_id"]: {"name": "KROGER #418"},
        }
    )
    (purchase,) = fetch_transactions(CONFIG, ["acc_1"], transport)
    assert purchase.description == "KROGER #418"


def test_a_merchant_is_looked_up_once() -> None:
    calls: list[str] = []
    transport = serve(
        {
            **account_routes("acc_1", purchases=[PURCHASE, {**PURCHASE, "_id": "p2"}]),
            "/merchants/" + PURCHASE["merchant_id"]: {"name": "KROGER #418"},
        },
        record_calls=calls,
    )
    fetch_transactions(CONFIG, ["acc_1"], transport)
    assert calls.count(f"/merchants/{PURCHASE['merchant_id']}") == 1


def test_an_unreachable_merchant_does_not_lose_the_purchase() -> None:
    """Best effort: the money still moved, so the record is still worth having."""
    transport = serve(account_routes("acc_1", purchases=[PURCHASE]))
    (purchase,) = fetch_transactions(CONFIG, ["acc_1"], transport)
    assert purchase.description == UNKNOWN_DESCRIPTION


def test_an_account_with_no_transfers_is_not_an_error() -> None:
    """Transfers 404 with a string body where the other kinds return []."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/transfers"):
            return httpx.Response(404, json="No transfers found for this account")
        if request.url.path.endswith("/deposits"):
            return httpx.Response(200, json=[DEPOSIT])
        return httpx.Response(200, json=[])

    feed = fetch_transactions(CONFIG, ["acc_1"], httpx.MockTransport(handler))
    assert [t.type for t in feed] == ["deposit"]


def test_several_accounts_are_combined() -> None:
    transport = serve(
        {
            **account_routes("acc_1", deposits=[DEPOSIT]),
            **account_routes("acc_2", withdrawals=[WITHDRAWAL]),
        }
    )
    feed = fetch_transactions(CONFIG, ["acc_1", "acc_2"], transport)
    assert {t.account_id for t in feed} == {"acc_1", "acc_2"}


# --- Failure ------------------------------------------------------------------


def test_a_server_error_is_reported() -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(500, text="boom"))
    with pytest.raises(NessieError, match="500"):
        fetch_accounts(CONFIG, transport)


def test_an_unreachable_host_is_reported() -> None:
    def explode(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with pytest.raises(NessieError, match="Could not reach Nessie"):
        fetch_accounts(CONFIG, httpx.MockTransport(explode))


def test_the_api_key_never_reaches_an_error_message() -> None:
    """The key travels as a query parameter, so it lands in httpx's own messages."""

    def explode(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"failed to connect to {request.url}")

    with pytest.raises(NessieError) as caught:
        fetch_accounts(CONFIG, httpx.MockTransport(explode))
    assert CONFIG.api_key not in str(caught.value)
    assert "***" in str(caught.value)


def test_redact_leaves_ordinary_text_alone() -> None:
    assert redact("no secrets here", "secret-key") == "no secrets here"
    assert redact("key=secret-key", "secret-key") == "key=***"
