from datetime import date, timedelta

import pytest

from backend.fixtures import load_twin
from backend.schemas import Goal, OneTimeObligation, SeasonalProfile, SimulationEvent
from backend.simulation.engine import (
    LOW_BALANCE_THRESHOLD,
    MAX_HORIZON_DAYS,
    SimulationError,
    compare,
    evaluate_goals,
    monthly_due_dates,
    resolve_horizon_end,
    simulate_scenario,
)
from backend.simulation.monte_carlo import run_monte_carlo

HORIZON = date(2027, 5, 1)


def purchase(amount: float, on: str = "2026-09-20", account_id: str = "acc_checking") -> SimulationEvent:
    return SimulationEvent(
        type="purchase", description="Laptop", amount=amount, date=date.fromisoformat(on), account_id=account_id
    )


@pytest.fixture
def twin(flat_twin):
    # Hand-checked arithmetic below assumes flat 14-day spending.
    return flat_twin


# --- No hypothetical purchase -------------------------------------------------


def test_baseline_ending_balance_matches_closed_form(twin):
    result = simulate_scenario(twin, [], HORIZON)
    amount = {o.id: o.expected_amount for o in twin.obligations}
    paycheck = twin.income[0].expected_amount
    everyday = sum(v.mean_14d for v in twin.variable_spending)
    # 16 paychecks; rent x8, utilities x7, phone x8, subscriptions x7, transfer x7;
    # every day from as_of to the horizon. The counts are the point here; the
    # amounts are read off the twin, which measured them from the feed.
    income = 16 * paycheck
    bills = (
        8 * amount["obl_hokie_property_mgmt_rent"]
        + 7 * amount["obl_town_electric_utility"]
        + 8 * amount["obl_verizon_wireless"]
        + 7 * amount["obl_spotify_premium"]
        + 7 * amount["obl_online_transfer_to"]
    )
    spending = everyday / 14 * (HORIZON - twin.as_of).days
    assert result.total_income == pytest.approx(income, abs=0.01)
    assert result.ending_balance == pytest.approx(3140 + income - bills - spending, abs=0.01)


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
    assert sweep.obligation_id == "obl_hokie_property_mgmt_rent"
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
    assert first.obligation_id == "obl_hokie_property_mgmt_rent"
    assert first.due == date(2026, 10, 1)
    assert first.checking_after < 0


def test_a_sweep_moves_money_without_creating_or_destroying_any(twin):
    result = simulate_scenario(twin, [purchase(1300, on="2026-09-26")], HORIZON)
    no_sweep_possible = twin.model_copy(
        update={"accounts": [a for a in twin.accounts if a.type != "savings"]}
    )
    # Same total either way: a sweep relocates money, it does not conjure it. The
    # savings account holds 1800 that the checking-only twin never had.
    assert result.savings_sweeps
    assert result.ending_balance == pytest.approx(
        simulate_scenario(no_sweep_possible, [purchase(1300, on="2026-09-26")], HORIZON).ending_balance
        + 1800,
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
    rent = next(o for o in twin.obligations if o.id == "obl_hokie_property_mgmt_rent")
    optional = next(o for o in twin.obligations if o.id == "obl_spotify_premium")
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
    rent = next(o for o in twin.obligations if o.id == "obl_hokie_property_mgmt_rent")
    phone = next(o for o in twin.obligations if o.id == "obl_verizon_wireless")
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
    assert [u.obligation_id for u in result.uncovered_obligations] == ["obl_verizon_wireless"]
    assert result.uncovered_obligations[0].checking_after == pytest.approx(-30.0)


def test_a_declared_savings_transfer_never_sweeps_from_savings(twin):
    declared = twin.model_copy(
        update={
            "obligations": [
                o.model_copy(update={"declared_category": "savings_transfer"})
                if o.id == "obl_online_transfer_to"
                else o
                for o in twin.obligations
            ]
        }
    )
    result = simulate_scenario(declared, [purchase(1300, on="2026-09-26")], HORIZON)
    assert all(s.obligation_id != "obl_online_transfer_to" for s in result.savings_sweeps)


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


# --- Paused obligations ---------------------------------------------------------

RENT = "obl_hokie_property_mgmt_rent"


def pause(twin, obligation_id: str):
    return twin.model_copy(
        update={
            "obligations": [
                o.model_copy(update={"active": False}) if o.id == obligation_id else o
                for o in twin.obligations
            ]
        }
    )


def test_pausing_rent_raises_the_ending_balance_by_the_rent_it_skips(twin):
    rent = next(o for o in twin.obligations if o.id == RENT)
    months = len(monthly_due_dates(rent.due_day, twin.as_of, HORIZON))
    before = simulate_scenario(twin, [], HORIZON)
    after = simulate_scenario(pause(twin, RENT), [], HORIZON)
    assert months == 8
    assert after.ending_balance == pytest.approx(
        before.ending_balance + months * rent.expected_amount, abs=0.01
    )


def test_a_paused_obligation_is_never_charged_or_blamed(twin):
    # Checking cannot cover rent here, so an active rent would sweep or go uncovered.
    paused = pause(twin, RENT)
    result = simulate_scenario(paused, [purchase(1300, on="2026-09-26")], HORIZON)
    assert all(s.obligation_id != RENT for s in result.savings_sweeps)
    assert all(u.obligation_id != RENT for u in result.uncovered_obligations)


def test_pausing_every_obligation_leaves_only_income_and_spending(twin):
    none_active = twin.model_copy(
        update={"obligations": [o.model_copy(update={"active": False}) for o in twin.obligations]}
    )
    result = simulate_scenario(none_active, [], HORIZON)
    everyday = sum(v.mean_14d for v in twin.variable_spending)
    spending = everyday / 14 * (HORIZON - twin.as_of).days
    assert result.ending_balance == pytest.approx(3140 + result.total_income - spending, abs=0.01)
    assert result.obligations_covered


def test_all_obligations_active_reproduces_the_projection_exactly(twin):
    """No-regression (PER-6): the filter must not move a number while nothing is paused."""
    explicit = twin.model_copy(
        update={"obligations": [o.model_copy(update={"active": True}) for o in twin.obligations]}
    )
    assert simulate_scenario(explicit, [purchase(800)], HORIZON) == simulate_scenario(
        twin, [purchase(800)], HORIZON
    )


# --- One-time obligations ------------------------------------------------------


def owed(
    amount: float,
    due: str,
    *,
    id: str = "one_tuition",
    name: str = "Tuition",
    account_id: str = "acc_checking",
    mandatory: bool = True,
) -> OneTimeObligation:
    return OneTimeObligation(
        id=id,
        name=name,
        amount=amount,
        due_date=date.fromisoformat(due),
        account_id=account_id,
        mandatory=mandatory,
    )


def owing(twin, *obligations: OneTimeObligation):
    return twin.model_copy(update={"one_time_obligations": list(obligations)})


def test_an_empty_list_of_one_time_obligations_changes_nothing(twin):
    """The no-regression proof: every twin on file has this list empty."""
    assert simulate_scenario(owing(twin), [], HORIZON) == simulate_scenario(twin, [], HORIZON)


def test_a_one_time_obligation_is_spent_in_the_baseline(twin):
    with_it = simulate_scenario(owing(twin, owed(1000, "2026-11-10")), [], HORIZON)
    without = simulate_scenario(twin, [], HORIZON)
    assert with_it.ending_balance == pytest.approx(without.ending_balance - 1000, abs=0.01)


def test_a_one_time_obligation_after_the_horizon_changes_nothing(twin):
    after = owing(twin, owed(1000, "2027-06-01"))
    assert simulate_scenario(after, [], HORIZON) == simulate_scenario(twin, [], HORIZON)


def test_a_one_time_obligation_before_as_of_is_not_applied(twin):
    """as_of balances already include whatever was spent before them."""
    already = owing(twin, owed(1000, "2026-09-01"))
    assert simulate_scenario(already, [], HORIZON) == simulate_scenario(twin, [], HORIZON)


def test_a_one_time_obligation_on_as_of_itself_is_not_applied(twin):
    """The window is (as_of, horizon_end], the same as every other flow."""
    today = owing(twin, owed(1000, twin.as_of.isoformat()))
    assert simulate_scenario(today, [], HORIZON) == simulate_scenario(twin, [], HORIZON)


def test_a_mandatory_one_time_obligation_checking_cannot_cover_sweeps_savings(twin):
    # 2026-09-20: before the 9/25 paycheck, so checking has only its opening 1340.
    result = simulate_scenario(owing(twin, owed(1500, "2026-09-20")), [], HORIZON)
    assert result.obligations_covered
    [sweep] = [s for s in result.savings_sweeps if s.obligation_id == "one_tuition"]
    assert sweep.due == date(2026, 9, 20) and sweep.amount > 0


def test_a_mandatory_one_time_obligation_savings_cannot_cover_either_is_uncovered(twin):
    drained = twin.model_copy(
        update={"accounts": [a.model_copy(update={"balance": 0.0}) if a.type == "savings" else a
                             for a in twin.accounts]}
    )
    result = simulate_scenario(owing(drained, owed(1500, "2026-09-20")), [], HORIZON)
    assert not result.obligations_covered
    first = result.uncovered_obligations[0]
    assert (first.obligation_id, first.due) == ("one_tuition", date(2026, 9, 20))
    assert first.checking_after < 0


def test_a_non_mandatory_one_time_obligation_is_charged_but_never_blamed(twin):
    """Exactly how a non-mandatory *recurring* obligation already behaves: the money
    leaves, but negative checking is not reported as a bill that went unpaid."""
    bare = twin.model_copy(update={"obligations": [], "income": [], "variable_spending": []})
    result = simulate_scenario(
        owing(bare, owed(2000, "2026-09-20", mandatory=False)), [], date(2026, 9, 30)
    )
    assert result.checking[-1] == pytest.approx(1340 - 2000)
    assert result.obligations_covered and result.savings_sweeps == []


def test_a_one_time_obligation_paid_from_savings_leaves_checking_alone(twin):
    from_savings = owing(twin, owed(1000, "2026-11-10", account_id="acc_savings"))
    result = simulate_scenario(from_savings, [], HORIZON)
    baseline = simulate_scenario(twin, [], HORIZON)
    assert result.checking == baseline.checking
    assert result.ending_balance == pytest.approx(baseline.ending_balance - 1000, abs=0.01)


def test_a_one_time_and_a_recurring_obligation_on_one_day_both_apply(twin):
    rent = next(o for o in twin.obligations if "rent" in o.name.lower())
    same_day = twin.model_copy(
        update={
            "obligations": [rent],
            "accounts": [a.model_copy(update={"balance": 660.0}) if a.type == "checking"
                         else a.model_copy(update={"balance": 0.0}) for a in twin.accounts],
            "income": [],
            "variable_spending": [],
        }
    )
    result = simulate_scenario(
        owing(same_day, owed(40, "2026-10-01", id="one_fee", name="Late fee")), [], date(2026, 10, 2)
    )
    # Both are charged: 660 - 650 - 40. Mandatory first across the two kinds, so the
    # $650 rent is paid and the one-time fee is the charge that cannot be covered.
    assert result.checking[-1] == pytest.approx(-30.0)
    assert [u.obligation_id for u in result.uncovered_obligations] == ["one_fee"]


def test_a_funding_account_that_no_longer_exists_falls_back_to_checking(twin):
    """C3, undefined in the spec: the charge is still real, so it is not dropped."""
    dangling = owing(twin, owed(1000, "2026-11-10", account_id="acc_deleted"))
    result = simulate_scenario(dangling, [], HORIZON)
    expected = simulate_scenario(owing(twin, owed(1000, "2026-11-10")), [], HORIZON)
    assert result.ending_balance == pytest.approx(expected.ending_balance, abs=0.01)


def test_due_day_31_clamps_to_month_end():
    assert monthly_due_dates(31, date(2027, 1, 31), date(2027, 4, 30)) == [
        date(2027, 2, 28),
        date(2027, 3, 31),
        date(2027, 4, 30),
    ]


# --- Goal impact ---------------------------------------------------------------


def test_what_is_available_for_the_goal_is_the_balance_minus_the_reserve(twin):
    c = compare(twin, [purchase(800)])
    base_goal = c.baseline.goals[0]
    # Available for the goal = balance at deadline minus the $1,500 reserve.
    assert base_goal.available == pytest.approx(c.baseline.ending_balance - 1500)
    assert base_goal.shortfall == 0
    assert base_goal.surplus == pytest.approx(base_goal.available - 1600)


def test_laptop_creates_goal_shortfall():
    """Against Alex's own twin, seasonal profiles and all, because that is the claim.

    The shortfall needs the seasonal shape. The laptop lands in the busy autumn,
    and it is that concentration of spending in the months right after the
    purchase that puts the goal out of reach. Spread the same annual spending
    evenly -- the flat twin every other test in this module uses -- and the goal
    survives the purchase.
    """
    c = compare(load_twin(), [purchase(800)])
    base_goal, cf_goal = c.baseline.goals[0], c.counterfactual.goals[0]
    assert base_goal.shortfall == 0
    assert cf_goal.shortfall == pytest.approx(1600 - cf_goal.available)
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


def test_unfunded_goal_does_not_inflate_or_cascade_shortfalls(twin):
    early = Goal(id="goal_early", name="Early", target_amount=500, deadline=date(2026, 10, 1))
    later = Goal(id="goal_later", name="Later", target_amount=400, deadline=date(2026, 11, 1))
    twin = twin.model_copy(update={"goals": [early, later]})

    outcomes = evaluate_goals(
        twin,
        [twin.as_of, early.deadline, later.deadline],
        [twin.total_balance, 1400, 2000],
        reserve=1500,
    )

    assert outcomes[0].available == 0
    assert outcomes[0].shortfall == early.target_amount
    assert outcomes[1].available == 500
    assert outcomes[1].shortfall == 0
    assert outcomes[1].surplus == 100


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


# --- Horizon with no goals ----------------------------------------------------


@pytest.fixture
def goalless(twin):
    return twin.model_copy(update={"goals": []})


def test_a_goalless_twin_defaults_to_180_days_without_events(goalless):
    assert resolve_horizon_end(goalless, None) == goalless.as_of + timedelta(days=180)
    assert resolve_horizon_end(goalless, None, []) == goalless.as_of + timedelta(days=180)


def test_a_goalless_twin_stretches_its_horizon_to_a_purchase_200_days_out(goalless):
    on = goalless.as_of + timedelta(days=200)
    result = compare(goalless, [purchase(800, on=on.isoformat())])
    assert result.horizon_end == on
    assert result.baseline.ending_balance - result.counterfactual.ending_balance == 800


def test_monte_carlo_on_a_goalless_twin_simulates_a_purchase_200_days_out(goalless):
    on = goalless.as_of + timedelta(days=200)
    result = run_monte_carlo(goalless, [purchase(800, on=on.isoformat())], n_simulations=20, seed=1)
    assert result.horizon_end == on
    assert result.n_simulations == 20


def test_a_goalless_twin_keeps_180_days_when_the_purchase_is_earlier(goalless):
    assert compare(goalless, [purchase(800)]).horizon_end == goalless.as_of + timedelta(days=180)


def test_a_goalless_twin_accepts_a_purchase_on_the_last_allowed_day(goalless):
    on = goalless.as_of + timedelta(days=MAX_HORIZON_DAYS)
    assert compare(goalless, [purchase(800, on=on.isoformat())]).horizon_end == on


def test_a_goalless_twin_still_rejects_a_purchase_past_the_cap(goalless):
    on = goalless.as_of + timedelta(days=MAX_HORIZON_DAYS + 1)
    with pytest.raises(SimulationError):
        compare(goalless, [purchase(800, on=on.isoformat())])


def test_an_explicit_horizon_is_never_stretched_by_events(goalless):
    end = goalless.as_of + timedelta(days=90)
    on = goalless.as_of + timedelta(days=200)
    with pytest.raises(SimulationError):
        compare(goalless, [purchase(800, on=on.isoformat())], end)


def test_a_twin_with_goals_still_stops_at_its_earliest_deadline(twin):
    on = twin.as_of + timedelta(days=200)
    assert resolve_horizon_end(twin, None, [purchase(800, on=on.isoformat())]) == HORIZON


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
    everyday = sum(v.mean_14d for v in twin.variable_spending)
    days = [twin.as_of + timedelta(days=i) for i in range(1, (HORIZON - twin.as_of).days + 1)]
    # Sep 19 - Dec 31 at 1.5x, Jan 1 - Apr 30 at 0.5x, May 1 at 1.0x: 104 heavy
    # days against 120 light ones.
    extra = sum(everyday / 14 * (TERM_SHAPE[d.month] - 1) for d in days)
    assert extra == pytest.approx(everyday / 14 * (104 * 0.5 - 120 * 0.5))
    assert result.ending_balance == pytest.approx(flat.ending_balance - extra, abs=0.01)


def test_a_heavy_month_spends_faster_than_a_light_one(twin):
    result = simulate_scenario(with_profile(twin, TERM_SHAPE), [], HORIZON)
    checking = dict(zip(result.dates, result.checking))
    # Two paycheck-free, bill-free stretches of equal length: Oct 10-14 and Jan 10-14.
    everyday = sum(v.mean_14d for v in twin.variable_spending)
    october = checking[date(2026, 10, 10)] - checking[date(2026, 10, 14)]
    january = checking[date(2027, 1, 10)] - checking[date(2027, 1, 14)]
    assert october == pytest.approx(4 * everyday / 14 * 1.5, abs=0.01)
    assert january == pytest.approx(4 * everyday / 14 * 0.5, abs=0.01)
