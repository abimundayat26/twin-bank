from datetime import date, timedelta

import pytest

from backend.fixtures import load_twin
from backend.schemas import Goal, SimulationEvent
from backend.simulation.engine import (
    LOW_BALANCE_THRESHOLD,
    MAX_HORIZON_DAYS,
    SimulationError,
    compare,
    monthly_due_dates,
    simulate_scenario,
)

HORIZON = date(2027, 5, 1)


def purchase(amount: float, on: str = "2026-09-20", account_id: str = "acc_checking") -> SimulationEvent:
    return SimulationEvent(
        type="purchase", description="Laptop", amount=amount, date=date.fromisoformat(on), account_id=account_id
    )


@pytest.fixture
def twin():
    return load_twin()


# --- No hypothetical purchase -------------------------------------------------


def test_baseline_ending_balance_matches_closed_form(twin):
    result = simulate_scenario(twin, [], HORIZON)
    # 16 paychecks; rent x8, utilities x7, phone x8, subscriptions x7, mystery transfer x7; 224 days of spending.
    income = 16 * 720
    bills = 8 * 650 + 7 * 60 + 8 * 40 + 7 * 25 + 7 * 75
    spending = 260 / 14 * 224
    assert result.total_income == income
    assert result.ending_balance == pytest.approx(2840 + income - bills - spending, abs=0.01)


def test_baseline_is_healthy(twin):
    result = simulate_scenario(twin, [], HORIZON)
    assert not result.dropped_below_low
    assert not result.reserve_violated
    assert result.obligations_covered
    assert result.goal_shortfall == 0
    assert result.dates[0] == twin.as_of and result.dates[-1] == HORIZON


def test_horizon_defaults_to_earliest_goal_deadline(twin):
    assert compare(twin, [purchase(800)]).horizon_end == HORIZON


def test_simulation_is_deterministic(twin):
    assert simulate_scenario(twin, [], HORIZON) == simulate_scenario(twin, [], HORIZON)


# --- $800 laptop --------------------------------------------------------------


def test_laptop_lowers_balances_by_exactly_800(twin):
    c = compare(twin, [purchase(800)])
    assert c.counterfactual.ending_balance == pytest.approx(c.baseline.ending_balance - 800)
    assert c.counterfactual.min_balance == pytest.approx(c.baseline.min_balance - 800)
    assert c.counterfactual.min_checking == pytest.approx(c.baseline.min_checking - 800)


def test_laptop_drops_checking_below_low_threshold(twin):
    c = compare(twin, [purchase(800)])
    assert c.baseline.min_checking >= LOW_BALANCE_THRESHOLD
    assert c.counterfactual.min_checking < LOW_BALANCE_THRESHOLD
    assert c.counterfactual.dropped_below_low


def test_laptop_keeps_reserve_and_obligations(twin):
    c = compare(twin, [purchase(800)])
    assert not c.counterfactual.reserve_violated
    assert c.counterfactual.obligations_covered


# --- Emergency reserve ---------------------------------------------------------


def test_large_purchase_violates_reserve(twin):
    c = compare(twin, [purchase(1500)])
    assert not c.baseline.reserve_violated
    assert c.counterfactual.reserve_violated
    assert c.counterfactual.min_balance < 1500


def test_no_reserve_constraint_is_never_violated(twin):
    twin = twin.model_copy(update={"constraints": []})
    assert not simulate_scenario(twin, [purchase(1500)], HORIZON).reserve_violated


# --- Obligation coverage -------------------------------------------------------


def test_purchase_that_empties_checking_leaves_rent_uncovered(twin):
    # After the 9/25 paycheck, so only October rent is left uncovered.
    result = simulate_scenario(twin, [purchase(1300, on="2026-09-26")], HORIZON)
    assert not result.obligations_covered
    first = result.uncovered_obligations[0]
    assert first.obligation_id == "obl_rent"
    assert first.due == date(2026, 10, 1)
    assert first.checking_after < 0


def test_purchase_from_savings_does_not_affect_checking_coverage(twin):
    c = compare(twin, [purchase(1300, account_id="acc_savings")])
    assert c.counterfactual.obligations_covered
    assert c.counterfactual.checking == c.baseline.checking
    assert c.counterfactual.reserve_violated


def test_optional_obligation_shortfall_does_not_count_as_uncovered(twin):
    # Only the optional subscription remains, so negative checking is not an uncovered bill.
    optional_only = twin.model_copy(
        update={"obligations": [o for o in twin.obligations if not o.mandatory], "income": []}
    )
    result = simulate_scenario(optional_only, [purchase(1300)], date(2026, 10, 31))
    assert result.min_checking < 0
    assert result.obligations_covered


def test_due_day_31_clamps_to_month_end():
    assert monthly_due_dates(31, date(2027, 1, 31), date(2027, 4, 30)) == [
        date(2027, 2, 28),
        date(2027, 3, 31),
        date(2027, 4, 30),
    ]


# --- Goal impact ---------------------------------------------------------------


def test_laptop_creates_goal_shortfall(twin):
    c = compare(twin, [purchase(800)])
    base_goal, cf_goal = c.baseline.goals[0], c.counterfactual.goals[0]
    # Available for the goal = balance at deadline minus the $1,500 reserve.
    assert base_goal.available == pytest.approx(c.baseline.ending_balance - 1500)
    assert base_goal.shortfall == 0
    assert base_goal.surplus == pytest.approx(base_goal.available - 2000)
    assert cf_goal.shortfall == pytest.approx(2000 - cf_goal.available)
    assert c.counterfactual.goal_shortfall == cf_goal.shortfall > 0


def test_goal_is_measured_at_its_own_deadline(twin):
    early = Goal(id="goal_early", name="Deposit", target_amount=500, deadline=date(2026, 12, 1))
    twin = twin.model_copy(update={"goals": [early, *twin.goals]})
    result = simulate_scenario(twin, [], HORIZON)
    by_id = {g.goal_id: g for g in result.goals}
    total_on = dict(zip(result.dates, result.total))
    assert by_id["goal_early"].available == pytest.approx(total_on[date(2026, 12, 1)] - 1500)
    # Later goals are funded after earlier goals' targets.
    assert by_id["goal_summer_housing"].available == pytest.approx(result.ending_balance - 1500 - 500)


def test_goal_after_horizon_is_not_evaluated(twin):
    result = simulate_scenario(twin, [], date(2027, 1, 1))
    assert result.goals == []
    assert result.goal_shortfall == 0


# --- Validation ----------------------------------------------------------------


def test_unknown_account_is_rejected(twin):
    with pytest.raises(SimulationError):
        compare(twin, [purchase(800, account_id="acc_nope")])


def test_event_before_as_of_is_rejected(twin):
    with pytest.raises(SimulationError):
        compare(twin, [purchase(800, on="2026-09-01")])


def test_horizon_before_as_of_is_rejected(twin):
    with pytest.raises(SimulationError):
        compare(twin, [purchase(800)], date(2026, 9, 1))


def test_horizon_at_the_cap_is_allowed(twin):
    end = twin.as_of + timedelta(days=MAX_HORIZON_DAYS)
    assert compare(twin, [purchase(800)], end).horizon_end == end


def test_horizon_past_the_cap_is_rejected(twin):
    with pytest.raises(SimulationError):
        compare(twin, [purchase(800)], twin.as_of + timedelta(days=MAX_HORIZON_DAYS + 1))
