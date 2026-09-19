"""Unit tests for raw -> normalized transactions. Pure functions, hand-built input."""

from datetime import date

import pytest

from backend.ingest import Transaction, categorize, normalize, normalize_all
from backend.ingest.models import RawTransaction


def raw(**overrides) -> RawTransaction:
    defaults = {
        "_id": "txn_0001",
        "account_id": "acc_checking",
        "type": "purchase",
        "transaction_date": "2026-09-01",
        "amount": 40.0,
        "description": "KROGER #418",
        "status": "completed",
    }
    return RawTransaction.model_validate({**defaults, **overrides})


# --- signs --------------------------------------------------------------------


def test_deposit_is_positive():
    assert normalize(raw(type="deposit", description="CAMPUS BOOKSTORE PAYROLL")).amount == 40.0


@pytest.mark.parametrize("raw_type", ["purchase", "withdrawal", "transfer"])
def test_outflows_are_negative(raw_type):
    assert normalize(raw(type=raw_type)).amount == -40.0


def test_sign_ignores_the_sign_the_feed_supplied():
    """Nessie amounts are unsigned; direction comes from `type`, not the number."""
    assert normalize(raw(type="purchase", amount=40.0)).amount == -40.0
    assert normalize(raw(type="deposit", amount=40.0)).amount == 40.0


# --- categories ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("description", "expected"),
    [
        ("CAMPUS BOOKSTORE PAYROLL", "income"),
        ("HOKIE PROPERTY MGMT RENT", "rent"),
        ("TOWN ELECTRIC UTILITY", "utilities"),
        ("VERIZON WIRELESS", "phone"),
        ("SPOTIFY PREMIUM", "subscriptions"),
        ("KROGER #418", "groceries"),
        ("DOORDASH*ORDER", "discretionary"),
        ("ONLINE TRANSFER TO ***4471", "transfer"),
    ],
)
def test_categorize_by_keyword(description, expected):
    assert categorize(description) == expected


@pytest.mark.parametrize(
    "description",
    ["Current account fee", "Parent payment", "Torrent VPN", "Shell gas co", "Barnes & Noble"],
)
def test_keywords_only_match_whole_words(description):
    assert categorize(description) == "other"


def test_multi_word_keywords_match():
    assert categorize("ACME DIRECT DEPOSIT") == "income"
    assert categorize("Dominion natural gas") == "utilities"


def test_categorize_is_case_insensitive():
    assert categorize("Kroger #418") == categorize("KROGER #418") == "groceries"


def test_unrecognized_description_is_other_not_a_guess():
    assert categorize("SQ *UNKNOWN VENDOR 8812") == "other"


def test_raw_type_is_the_fallback_when_no_keyword_matches():
    assert categorize("SQ *UNKNOWN VENDOR 8812", "deposit") == "income"
    assert categorize("SQ *UNKNOWN VENDOR 8812", "transfer") == "transfer"


def test_an_opaque_transfer_stays_a_transfer():
    """SPEC section 2: the system must not decide on its own that this is savings."""
    transaction = normalize(raw(type="transfer", description="ONLINE TRANSFER TO ***4471"))
    assert transaction.category == "transfer"


# --- the batch ----------------------------------------------------------------


def test_normalize_all_drops_unsettled_events():
    feed = [
        raw(_id="txn_0001", status="completed"),
        raw(_id="txn_0002", status="pending"),
        raw(_id="txn_0003", status="cancelled"),
    ]
    assert [t.id for t in normalize_all(feed)] == ["txn_0001"]


def test_normalize_all_sorts_oldest_first_then_by_id():
    feed = [
        raw(_id="txn_0003", transaction_date="2026-09-03"),
        raw(_id="txn_0002", transaction_date="2026-09-01"),
        raw(_id="txn_0001", transaction_date="2026-09-01"),
    ]
    assert [t.id for t in normalize_all(feed)] == ["txn_0001", "txn_0002", "txn_0003"]


def test_normalized_transactions_carry_observed_provenance():
    transaction = normalize(raw())
    assert isinstance(transaction, Transaction)
    assert transaction.provenance == "observed"
    assert transaction.date == date(2026, 9, 1)
