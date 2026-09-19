"""Capital One Nessie -> RawTransaction[].

The edge of the system. This module speaks HTTP and returns the same shapes the
mock feed already produces; it does not categorize, detect recurrence or do any
money maths. `ingest/normalize.py` stays pure and unaware that a network exists.

Everything awkward about Nessie is handled in `to_raw`, which is a pure function
so the awkwardness is testable without a socket. The quirks below were observed
against the live API on 2026-09-19, not inferred from the docs:

* the transaction's kind is *not* in the payload. A purchase carries
  `"type": "merchant"`, which is not one of our `RawType` values, so the type
  comes from the endpoint that returned the record and the payload's own `type`
  is ignored;
* purchases date-stamp with `purchase_date`; every other kind uses
  `transaction_date`;
* `description` may be null on a purchase, so it falls back to the merchant's
  name and then to a placeholder. Losing it would matter: the categorizer reads
  descriptions, and a feed of blank purchases would all land in "other";
* the transfers endpoint 404s with a *string* body when an account has none,
  where the other kinds return `[]`;
* a bad key does not fail. It answers `200 []`, which looks exactly like a
  customer with no money -- so an empty account list is treated as an error.
"""

import httpx

from backend.ingest.models import RawTransaction, RawType
from backend.nessie.config import NessieConfig
from backend.schemas import Account

# The endpoints a transaction can come from, and what each one means.
KIND_TO_TYPE: dict[str, RawType] = {
    "purchases": "purchase",
    "deposits": "deposit",
    "withdrawals": "withdrawal",
    "transfers": "transfer",
}

# Nessie's date field is per-endpoint. Purchases are the odd one out.
DATE_FIELDS = {"purchases": "purchase_date"}
DEFAULT_DATE_FIELD = "transaction_date"

# Nessie capitalizes account types and offers kinds we cannot simulate.
ACCOUNT_TYPES = {"checking": "checking", "savings": "savings"}

UNKNOWN_DESCRIPTION = "Unknown merchant"


class NessieError(RuntimeError):
    """Nessie could not be reached, or answered with something unusable."""


def redact(text: str, api_key: str) -> str:
    """Keep the API key out of anything we raise, log or print."""
    return text.replace(api_key, "***") if api_key else text


def to_raw(
    kind: str, account_id: str, record: dict, description: str | None = None
) -> RawTransaction:
    """One Nessie record as a RawTransaction.

    `account_id` is the account we asked for, not a field of the record: the
    payload calls it `payer_id` on some kinds and omits it on others, and we
    always fetch per account, so the path is the reliable source.

    `description` overrides the record's own, which is how a purchase gets its
    merchant name when Nessie left the description null.
    """
    if kind not in KIND_TO_TYPE:
        raise NessieError(f"Unknown transaction kind '{kind}'")
    date_field = DATE_FIELDS.get(kind, DEFAULT_DATE_FIELD)
    when = record.get(date_field)
    if not when:
        raise NessieError(f"A {kind} record is missing '{date_field}'")
    text = description or record.get("description") or UNKNOWN_DESCRIPTION
    return RawTransaction(
        _id=str(record.get("_id") or record.get("id") or ""),
        account_id=account_id,
        # From the endpoint, never from record["type"]: a purchase says "merchant".
        type=KIND_TO_TYPE[kind],
        transaction_date=when,
        # Unsigned in principle, but not always in practice.
        amount=abs(float(record.get("amount", 0))),
        description=str(text).strip() or UNKNOWN_DESCRIPTION,
        status=str(record.get("status") or "completed"),
    )


def to_account(record: dict) -> Account | None:
    """A Nessie account as one of ours, or None for a kind we cannot simulate.

    Credit cards and loans are skipped rather than coerced: the simulator moves
    cash between checking and savings and has no model for revolving debt.
    """
    kind = ACCOUNT_TYPES.get(str(record.get("type", "")).strip().lower())
    if kind is None:
        return None
    return Account(
        id=str(record["_id"]),
        name=str(record.get("nickname") or kind.title()),
        type=kind,
        balance=float(record.get("balance", 0)),
    )


def get(config: NessieConfig, path: str, transport: httpx.BaseTransport | None = None) -> object:
    """One GET, with the key as a query parameter and never in an error message."""
    try:
        with httpx.Client(timeout=config.timeout_seconds, transport=transport) as client:
            response = client.get(f"{config.base_url}{path}", params={"key": config.api_key})
    except httpx.HTTPError as e:
        raise NessieError(
            f"Could not reach Nessie at {path}: {redact(str(e), config.api_key)}"
        ) from e
    if response.status_code == 404:
        return None
    if response.status_code >= 400:
        raise NessieError(f"Nessie returned {response.status_code} for {path}")
    try:
        return response.json()
    except ValueError as e:
        raise NessieError(f"Nessie returned a non-JSON body for {path}") from e


def fetch_accounts(
    config: NessieConfig, transport: httpx.BaseTransport | None = None
) -> list[Account]:
    """The accounts this key owns, or the ones named in NESSIE_ACCOUNT_IDS.

    Raises rather than returning nothing. A wrong key answers `200 []`, and a
    twin silently built from no accounts would report a balance of zero as
    though it were a fact.
    """
    if config.account_ids:
        found = [get(config, f"/accounts/{account_id}", transport) for account_id in config.account_ids]
        records = [record for record in found if isinstance(record, dict)]
    else:
        listed = get(config, "/accounts", transport)
        records = listed if isinstance(listed, list) else []

    accounts = [account for record in records if (account := to_account(record)) is not None]
    if not accounts:
        raise NessieError(
            "Nessie returned no usable checking or savings accounts. Check NESSIE_API_KEY and "
            "NESSIE_ACCOUNT_IDS: an unrecognised key returns an empty list, not an error."
        )
    return accounts


def merchant_name(
    config: NessieConfig,
    merchant_id: str,
    cache: dict[str, str],
    transport: httpx.BaseTransport | None = None,
) -> str:
    """A merchant's name, looked up once per merchant and remembered.

    Best effort: a purchase with no description is still worth keeping, so a
    failed lookup degrades to a placeholder rather than failing the whole fetch.
    """
    if merchant_id not in cache:
        try:
            record = get(config, f"/merchants/{merchant_id}", transport)
        except NessieError:
            record = None
        cache[merchant_id] = str(record.get("name") or "") if isinstance(record, dict) else ""
    return cache[merchant_id]


def fetch_transactions(
    config: NessieConfig,
    account_ids: list[str] | None = None,
    transport: httpx.BaseTransport | None = None,
) -> list[RawTransaction]:
    """Every transaction on the given accounts, oldest first.

    Each kind lives behind its own endpoint, so this is one request per kind per
    account. Ids are unique across kinds, so the results simply concatenate.
    """
    if account_ids is None:
        account_ids = [account.id for account in fetch_accounts(config, transport)]

    merchants: dict[str, str] = {}
    transactions = []
    for account_id in account_ids:
        for kind in KIND_TO_TYPE:
            found = get(config, f"/accounts/{account_id}/{kind}", transport)
            # Transfers 404 with a string body when there are none; the other
            # kinds return []. Both mean "nothing here".
            if not isinstance(found, list):
                continue
            for record in found:
                override = None
                if kind == "purchases" and not record.get("description"):
                    override = (
                        merchant_name(
                            config, str(record.get("merchant_id") or ""), merchants, transport
                        )
                        or None
                    )
                transactions.append(to_raw(kind, account_id, record, override))
    return sorted(transactions, key=lambda t: (t.transaction_date, t.id))
