from datetime import date, timedelta

import pytest

from backend.fixtures import load_twin
from backend.schemas import Goal, SeasonalProfile, SimulationEvent
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


def test_purchase_that_empties_checking_makes_rent_come_out_of_savings(twin):
    # After the 9/25 paycheck, so October rent is the first bill checking cannot cover.
    result = simulate_scenario(twin, [purchase(1300, on="2026-09-26")], HORIZON)
    # Savings covers it, so the bill is paid -- but not silently.
    assert result.obligations_covered
    sweep = result.savings_sweeps[0]
    assert sweep.obligation_id == "obl_rent"
    assert sweep.due == date(2026, 10, 1)
    assert sweep.amount > 0


def test_rent_is_uncovered_only_when_savings_cannot_cover_it_either(twin):
    drained = twin.model_copy(
        update={"accounts": [a.model_copy(update={"balance": 0.0}) if a.type == "savings" else a
                             for a in twin.accounts]}
    )
    result = simulate_scenario(drained, [purchase(1300, on="2026-09-26")], HORIZON)
    assert not result.obligations_covered
    first = result.uncovered_obligations[0]
    assert first.obligation_id == "obl_rent"
    assert first.due == date(2026, 10, 1)
    assert first.checking_after < 0


def test_a_sweep_moves_money_without_creating_or_destroying_any(twin):
    result = simulate_scenario(twin, [purchase(1300, on="2026-09-26")], HORIZON)
    no_sweep_possible = twin.model_copy(
        update={"accounts": [a for a in twin.accounts if a.type != "savings"]}
    )
    # Same total either way: a sweep relocates money, it does not conjure it. The
    # savings account holds 1500 that the checking-only twin never had.
    assert result.savings_sweeps
    assert result.ending_balance == pytest.approx(
        simulate_scenario(no_sweep_possible, [purchase(1300, on="2026-09-26")], HORIZON).ending_balance
        + 1500,
        abs=0.01,
    )


def test_a_twin_with_no_savings_account_still_reports_uncovered_bills(twin):
    checking_only = twin.model_copy(
        update={"accounts": [a for a in twin.accounts if a.type != "savings"]}
    )
    result = simulate_scenario(checking_only, [purchase(1300, on="2026-09-26")], HORIZON)
    assert not result.obligations_covered
    assert result.savings_sweeps == []


def test_an_optional_charge_is_never_blamed_on_a_mandatory_bill(twin):
    """Rent and an optional charge fall on the same day; only rent can be paid."""
    rent = next(o for o in twin.obligations if o.id == "obl_rent")
    optional = next(o for o in twin.obligations if o.id == "obl_subscriptions")
    same_day = twin.model_copy(
        update={
            "obligations": [optional.model_copy(update={"due_day": 1}), rent],
            "accounts": [a.model_copy(update={"balance": 655.0}) if a.type == "checking"
                         else a.model_copy(update={"balance": 0.0}) for a in twin.accounts],
            "income": [],
            "variable_spending": [],
        }
    )
    result = simulate_scenario(same_day, [], date(2026, 10, 2))
    # The optional $25 is what pushes checking negative, and it is charged after rent.
    assert result.min_checking < 0
    assert result.obligations_covered
    assert result.savings_sweeps == []


def test_two_mandatory_bills_on_one_day_blame_only_the_one_that_fails(twin):
    rent = next(o for o in twin.obligations if o.id == "obl_rent")
    phone = next(o for o in twin.obligations if o.id == "obl_phone")
    same_day = twin.model_copy(
        update={
            "obligations": [rent, phone.model_copy(update={"due_day": 1})],
            "accounts": [a.model_copy(update={"balance": 660.0}) if a.type == "checking"
                         else a.model_copy(update={"balance": 0.0}) for a in twin.accounts],
            "income": [],
            "variable_spending": [],
        }
    )
    result = simulate_scenario(same_day, [], date(2026, 10, 2))
    # $660 pays the $650 rent; the $40 phone bill is the one that cannot be paid.
    assert [u.obligation_id for u in result.uncovered_obligations] == ["obl_phone"]
    assert result.uncovered_obligations[0].checking_after == pytest.approx(-30.0)


def test_a_declared_savings_transfer_never_sweeps_from_savings(twin):
    declared = twin.model_copy(
        update={
            "obligations": [
                o.model_copy(update={"declared_category": "savings_transfer"})
                if o.id == "obl_mystery_transfer"
                else o
                for o in twin.obligations
            ]
        }
    )
    result = simulate_scenario(declared, [purchase(1300, on="2026-09-26")], HORIZON)
    assert all(s.obligation_id != "obl_mystery_transfer" for s in result.savings_sweeps)


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


def test_a_purchase_savings_cannot_cover_is_flagged_as_overdrawing_it(twin):
    result = simulate_scenario(twin, [purchase(2000, account_id="acc_savings")], HORIZON)
    assert result.savings_overdrawn
    assert not simulate_scenario(twin, [purchase(2000)], HORIZON).savings_overdrawn


# --- Seasonal spending ----------------------------------------------------------

# Autumn term heavy, spring light, summer flat; averages 1.0 as the schema requires.
TERM_SHAPE = {m: 1.5 if m >= 9 else 0.5 if m <= 4 else 1.0 for m in range(1, 13)}


def with_profile(twin, factors: dict[int, float]):
    profile = SeasonalProfile(factors=factors)
    return twin.model_copy(
        update={"variable_spending": [v.model_copy(update={"seasonal": profile}) for v in twin.variable_spending]}
    )


def test_a_flat_profile_changes_nothing(twin):
    flat = with_profile(twin, dict.fromkeys(range(1, 13), 1.0))
    assert simulate_scenario(flat, [purchase(800)], HORIZON) == simulate_scenario(twin, [purchase(800)], HORIZON)


def test_seasonal_spending_follows_the_month_factor(twin):
    result = simulate_scenario(with_profile(twin, TERM_SHAPE), [], HORIZON)
    flat = simulate_scenario(twin, [], HORIZON)
    days = [twin.as_of + timedelta(days=i) for i in range(1, (HORIZON - twin.as_of).days + 1)]
    # Sep 20 - Dec 31 at 1.5x, Jan 1 - Apr 30 at 0.5x, May 1 at 1.0x of $260 per 14 days.
    extra = sum(260 / 14 * (TERM_SHAPE[d.month] - 1) for d in days)
    assert extra == pytest.approx(260 / 14 * (103 * 0.5 - 120 * 0.5))
    assert result.ending_balance == pytest.approx(flat.ending_balance - extra, abs=0.01)


def test_a_heavy_month_spends_faster_than_a_light_one(twin):
    result = simulate_scenario(with_profile(twin, TERM_SHAPE), [], HORIZON)
    checking = dict(zip(result.dates, result.checking))
    # Two paycheck-free, bill-free stretches of equal length: Oct 10-14 and Jan 10-14.
    october = checking[date(2026, 10, 10)] - checking[date(2026, 10, 14)]
    january = checking[date(2027, 1, 10)] - checking[date(2027, 1, 14)]
    assert october == pytest.approx(4 * 260 / 14 * 1.5, abs=0.01)
    assert january == pytest.approx(4 * 260 / 14 * 0.5, abs=0.01)
