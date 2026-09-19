"""Declared obligation categories and the user's minimum checking balance in the engine."""

from datetime import date

import pytest

from backend.fixtures import load_twin
from backend.schemas import FinancialConstraint
from backend.simulation.engine import LOW_BALANCE_THRESHOLD, low_balance_threshold, simulate_scenario

HORIZON = date(2027, 5, 1)
TRANSFER = "obl_mystery_transfer"
TRANSFERS_IN_HORIZON = 7  # due on the 5th, Oct 2026 through Apr 2027


def with_category(twin, obligation_id, category, **extra):
    obligations = [
        o.model_copy(update={"declared_category": category, **extra}) if o.id == obligation_id else o
        for o in twin.obligations
    ]
    return twin.model_copy(update={"obligations": obligations})


def with_minimum(twin, amount):
    constraint = FinancialConstraint(
        id="con_min", type="minimum_checking_balance", amount=amount, description="Minimum"
    )
    return twin.model_copy(update={"constraints": [*twin.constraints, constraint]})


@pytest.fixture
def twin():
    return load_twin()


@pytest.fixture
def undeclared(twin):
    return simulate_scenario(twin, [], HORIZON)


def test_not_recurring_is_left_out(twin, undeclared):
    result = simulate_scenario(with_category(twin, TRANSFER, "not_recurring"), [], HORIZON)
    assert result.ending_balance == pytest.approx(undeclared.ending_balance + TRANSFERS_IN_HORIZON * 75)
    assert result.min_checking > undeclared.min_checking


def test_savings_transfer_leaves_checking_but_keeps_total(twin, undeclared):
    spent = simulate_scenario(with_category(twin, TRANSFER, "optional_spending"), [], HORIZON)
    saved = simulate_scenario(with_category(twin, TRANSFER, "savings_transfer"), [], HORIZON)
    assert saved.checking == spent.checking == undeclared.checking
    assert saved.ending_balance == pytest.approx(spent.ending_balance + TRANSFERS_IN_HORIZON * 75)
    assert saved.min_balance > spent.min_balance


@pytest.mark.parametrize(
    "category, mandatory",
    [("bill", True), ("debt_repayment", True), ("optional_spending", False), ("savings_transfer", False)],
)
def test_declared_category_sets_mandatory(twin, category, mandatory):
    # A $5,000 obligation always overdraws checking, so it is flagged only if mandatory.
    big = with_category(twin, TRANSFER, category, expected_amount=5000.0)
    uncovered = {u.obligation_id for u in simulate_scenario(big, [], HORIZON).uncovered_obligations}
    assert (TRANSFER in uncovered) is mandatory


def test_undeclared_uses_observed_mandatory_flag(twin):
    big = with_category(twin, TRANSFER, None, expected_amount=5000.0)
    uncovered = {u.obligation_id for u in simulate_scenario(big, [], HORIZON).uncovered_obligations}
    assert TRANSFER not in uncovered


def test_low_balance_threshold_defaults(twin):
    assert low_balance_threshold(twin) == LOW_BALANCE_THRESHOLD


def test_low_balance_threshold_from_declared_minimum(twin, undeclared):
    assert low_balance_threshold(with_minimum(twin, 250)) == 250
    above_low = with_minimum(twin, undeclared.min_checking + 1)
    below_low = with_minimum(twin, max(0.0, undeclared.min_checking - 1))
    assert simulate_scenario(above_low, [], HORIZON).dropped_below_low is True
    assert simulate_scenario(below_low, [], HORIZON).dropped_below_low is False


def test_minimum_checking_balance_does_not_change_reserve(twin, undeclared):
    result = simulate_scenario(with_minimum(twin, 5000), [], HORIZON)
    assert result.reserve_violated == undeclared.reserve_violated
    assert result.goals == undeclared.goals
