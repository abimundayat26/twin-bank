"""Raw banking events -> normalized transactions.

Pure functions: no I/O, no randomness, no network. Two jobs only:

1. put a sign on the amount, so downstream code never has to know that a
   "purchase" of 40 means -40;
2. put a category on the description, by keyword.

Categorization is rules, not inference. When the rules do not match, the
category is "other" and the caller can see the description; when money moves
without a stated purpose, the category is "transfer" and stays there. The
normalizer never upgrades a transfer into "savings" — what a transfer means is
for the user to declare (SPEC section 2).
"""

from backend.ingest.models import Category, RawTransaction, Transaction

# Money in for these raw types, money out for everything else.
INFLOW_TYPES = frozenset({"deposit"})

# Only completed events describe what actually happened to the balance.
SETTLED_STATUSES = frozenset({"completed", "executed"})

# Checked in description order: the first category with a matching keyword wins,
# so put the specific ones first. Keywords are matched case-insensitively.
CATEGORY_KEYWORDS: tuple[tuple[Category, tuple[str, ...]], ...] = (
    ("income", ("payroll", "paycheck", "direct dep", "wages", "stipend")),
    ("rent", ("rent", "property mgmt", "leasing", "landlord")),
    ("utilities", ("electric", "power", "water", "gas co", "utility", "internet")),
    ("phone", ("wireless", "mobile", "phone plan", "cellular")),
    ("subscriptions", ("spotify", "netflix", "hulu", "subscription", "prime", "icloud")),
    ("groceries", ("grocery", "market", "kroger", "aldi", "food lion", "trader", "supermarket")),
    (
        "discretionary",
        ("coffee", "cafe", "restaurant", "bar ", "doordash", "uber", "amazon", "steam", "cinema"),
    ),
    ("transfer", ("transfer", "xfer", "zelle", "venmo")),
)


def categorize(description: str, raw_type: str = "purchase") -> Category:
    """Best-effort category from the description, falling back on the raw type.

    Returns "other" rather than guessing when nothing matches: an unexplained
    line item is a fact about the data, and later stages are allowed to see it.
    """
    haystack = description.lower()
    for category, keywords in CATEGORY_KEYWORDS:
        if any(keyword in haystack for keyword in keywords):
            return category
    if raw_type == "deposit":
        return "income"
    if raw_type == "transfer":
        return "transfer"
    return "other"


def signed_amount(raw: RawTransaction) -> float:
    """Positive for money in, negative for money out."""
    magnitude = abs(raw.amount)
    return round(magnitude if raw.type in INFLOW_TYPES else -magnitude, 2)


def is_settled(raw: RawTransaction) -> bool:
    return raw.status.lower() in SETTLED_STATUSES


def normalize(raw: RawTransaction) -> Transaction:
    return Transaction(
        id=raw.id,
        account_id=raw.account_id,
        date=raw.transaction_date,
        amount=signed_amount(raw),
        description=raw.description.strip(),
        category=categorize(raw.description, raw.type),
    )


def normalize_all(raws: list[RawTransaction]) -> list[Transaction]:
    """Normalize every settled event, oldest first.

    Pending and cancelled events are dropped: they have not moved the balance,
    so counting them would misstate both the history and the variance derived
    from it. Ties are broken by id so the order is stable across runs.
    """
    settled = [normalize(raw) for raw in raws if is_settled(raw)]
    return sorted(settled, key=lambda t: (t.date, t.id))
