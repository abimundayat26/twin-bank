"""Read Alex back out of Nessie and check he is still Alex.

Seeding was only proved by running it against the real sandbox: the seeder's
tests mock Nessie, and so missed a payload Nessie rejects. Reading back gets
the same treatment. This script builds the twin from the live sandbox and
compares it with the twin on file, using the tolerances `tests/test_recurrence.py`
already holds the mock feed to -- so "recognisable" means the same thing live as
it does in the test suite.

    cd backend
    uv run --env-file ../.env python -m backend.nessie.readback

Needs `USE_MOCKS=false` and `NESSIE_API_KEY` in the environment, as the app does.

It calls `build_from_nessie` directly rather than going through
`twin_source.load_source_twin`, which serves the fixture whenever Nessie fails.
Through that path a broken integration would come back looking like a perfect
match. A developer script, like `seed.py`: read-only, and never imported by the app.
"""

import sys

from backend.fixtures import load_twin
from backend.nessie.client import NessieError
from backend.nessie.config import load_config
from backend.schemas import FinancialTwin
from backend.twin_source import build_from_nessie

# The same tolerances tests/test_recurrence.py applies to the mock feed.
PAYCHECK_TOLERANCE = 40.0
BILL_RELATIVE_TOLERANCE = 0.1
SPENDING_TOLERANCE = 30.0


def compare(nessie: FinancialTwin, expected: FinancialTwin) -> list[str]:
    """Every way the Nessie twin fails to describe the person on file. Empty means a match."""
    problems = []

    if nessie.source != "nessie":
        problems.append(f"source is {nessie.source!r}, not 'nessie'")

    if len(nessie.income) != len(expected.income):
        problems.append(f"{len(nessie.income)} income streams, expected {len(expected.income)}")
    for found, wanted in zip(nessie.income, expected.income):
        if found.interval_days != wanted.interval_days:
            problems.append(
                f"paycheck every {found.interval_days} days, expected {wanted.interval_days}"
            )
        if abs(found.expected_amount - wanted.expected_amount) > PAYCHECK_TOLERANCE:
            problems.append(
                f"paycheck ${found.expected_amount:.2f}, expected about ${wanted.expected_amount:.2f}"
            )

    # Matched by due day, as the recurrence tests do: detection names a bill after
    # its merchant, so the day is the stable identity.
    found_bills = {o.due_day: o for o in nessie.obligations}
    wanted_bills = {o.due_day: o for o in expected.obligations}
    for day in sorted(wanted_bills.keys() - found_bills.keys()):
        problems.append(f"no bill detected on day {day} ({wanted_bills[day].name})")
    for day in sorted(found_bills.keys() - wanted_bills.keys()):
        problems.append(f"unexpected bill on day {day} ({found_bills[day].name})")
    for day in sorted(found_bills.keys() & wanted_bills.keys()):
        found, wanted = found_bills[day], wanted_bills[day]
        if abs(found.expected_amount - wanted.expected_amount) > (
            BILL_RELATIVE_TOLERANCE * wanted.expected_amount
        ):
            problems.append(
                f"bill on day {day} is ${found.expected_amount:.2f}, "
                f"expected about ${wanted.expected_amount:.2f}"
            )
        if found.mandatory != wanted.mandatory:
            problems.append(f"bill on day {day} has mandatory={found.mandatory}")

    # Declared data is never fetched (SPEC section 2), so it must come through untouched.
    if [g.model_dump() for g in nessie.goals] != [g.model_dump() for g in expected.goals]:
        problems.append("goals differ from the ones on file")
    if [c.model_dump() for c in nessie.constraints] != [
        c.model_dump() for c in expected.constraints
    ]:
        problems.append("constraints differ from the ones on file")

    found_types = sorted(a.type for a in nessie.accounts)
    wanted_types = sorted(a.type for a in expected.accounts)
    if found_types != wanted_types:
        problems.append(f"accounts are {found_types}, expected {wanted_types}")

    found_spending = {v.category: v for v in nessie.variable_spending}
    wanted_spending = {v.category: v for v in expected.variable_spending}
    if found_spending.keys() != wanted_spending.keys():
        problems.append(
            f"spending categories are {sorted(found_spending)}, expected {sorted(wanted_spending)}"
        )
    for category in sorted(found_spending.keys() & wanted_spending.keys()):
        found, wanted = found_spending[category], wanted_spending[category]
        if abs(found.mean_14d - wanted.mean_14d) > SPENDING_TOLERANCE:
            problems.append(
                f"{category} averages ${found.mean_14d:.2f} a fortnight, "
                f"expected about ${wanted.mean_14d:.2f}"
            )

    if nessie.forecast is None:
        problems.append("the twin records no forecast")

    return problems


def describe(twin: FinancialTwin) -> list[str]:
    """The handful of facts a person would check first."""
    lines = [f"as_of {twin.as_of}, source {twin.source}"]
    lines += [f"account  {a.type:<8} ${a.balance:,.2f}" for a in twin.accounts]
    lines += [
        f"income   ${i.expected_amount:,.2f} every {i.interval_days} days" for i in twin.income
    ]
    lines += [
        f"bill     day {o.due_day:>2}  ${o.expected_amount:,.2f}  {o.name}"
        for o in sorted(twin.obligations, key=lambda o: o.due_day)
    ]
    lines += [
        f"spending {v.category:<14} ${v.mean_14d:,.2f} / 14d"
        + ("  (seasonal)" if v.seasonal else "")
        for v in twin.variable_spending
    ]
    if twin.forecast:
        lines.append(
            f"forecast {twin.forecast.method}, {twin.forecast.observed_fortnights} fortnights"
        )
    return lines


def main() -> int:
    config = load_config()
    if config is None:
        print(
            "Nessie is not configured: set USE_MOCKS=false and NESSIE_API_KEY, e.g.\n"
            "  uv run --env-file ../.env python -m backend.nessie.readback",
            file=sys.stderr,
        )
        return 1

    try:
        twin = build_from_nessie(config)
    except NessieError as e:
        print(f"Reading from Nessie failed: {e}", file=sys.stderr)
        return 1

    expected = load_twin()
    print("From Nessie:")
    print("\n".join(f"  {line}" for line in describe(twin)))
    print("On file:")
    print("\n".join(f"  {line}" for line in describe(expected)))

    problems = compare(twin, expected)
    if problems:
        print(f"\nNot recognisable ({len(problems)}):")
        print("\n".join(f"  - {p}" for p in problems))
        return 1
    print("\nAlex is recognisable.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
