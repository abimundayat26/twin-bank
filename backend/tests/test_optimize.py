"""Optimization: candidate generation, constraint checks, ranking, and the /optimize API."""

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from backend.fixtures import load_twin
from backend.forecast import block_factor
from backend.main import app
from backend.schemas import (
    FinancialConstraint,
    OptimizationRequest,
    OptimizationResponse,
    SeasonalProfile,
    SimulationEvent,
)
from backend.simulation import SimulationError
from backend.simulation.engine import income_dates, resolve_horizon_end, spending_blocks
from backend.simulation.explain import build_optimization_summary, money
from backend.simulation.optimize import (
    MAX_DELAY_PAYDAYS,
    adjusted_twin,
    check_constraints,
    generate_candidates,
    run_optimization,
)

client = TestClient(app)
SEED = 11
N = 100


@pytest.fixture
def twin():
    return load_twin()


def laptop(amount: float = 800.0, day: date = date(2026, 9, 20), account: str = "acc_checking"):
    return SimulationEvent(
        type="purchase", description="Laptop", amount=amount, date=day, account_id=account
    )


def request(*events: SimulationEvent) -> OptimizationRequest:
    return OptimizationRequest(user_id="alex", events=list(events) or [laptop()])


def optimize(twin, *events: SimulationEvent) -> OptimizationResponse:
    return run_optimization(twin, request(*events), n_simulations=N, seed=SEED)


# --- candidates ---------------------------------------------------------------


def test_buy_now_is_the_request_unchanged(twin):
    end = resolve_horizon_end(twin, None)
    buy_now = generate_candidates(twin, [laptop()], end)[0]
    assert buy_now.kind == "buy_now"
    assert buy_now.events == [laptop()]


def test_delays_land_the_day_after_an_upcoming_payday(twin):
    end = resolve_horizon_end(twin, None)
    delays = [c for c in generate_candidates(twin, [laptop()], end) if c.kind == "delay"]
    stream = twin.income[0]
    paydays = income_dates(stream.next_date, stream.interval_days, date(2026, 9, 20), end)
    assert len(delays) == MAX_DELAY_PAYDAYS
    assert [c.events[0].date for c in delays] == [
        d + timedelta(days=1) for d in paydays[:MAX_DELAY_PAYDAYS]
    ]


def test_delays_never_pass_the_horizon(twin):
    end = date(2026, 10, 10)
    delays = [c for c in generate_candidates(twin, [laptop()], end) if c.kind == "delay"]
    assert delays
    assert all(c.events[0].date <= end for c in delays)


def test_delays_shift_every_event_by_the_same_amount(twin):
    end = resolve_horizon_end(twin, None)
    events = [laptop(day=date(2026, 9, 20)), laptop(amount=50, day=date(2026, 9, 22))]
    delay = next(c for c in generate_candidates(twin, events, end) if c.kind == "delay")
    assert (delay.events[1].date - delay.events[0].date).days == 2


def test_no_savings_account_means_no_savings_option(twin):
    no_savings = twin.model_copy(update={"accounts": [twin.accounts[0]]})
    end = resolve_horizon_end(no_savings, None)
    kinds = {c.kind for c in generate_candidates(no_savings, [laptop()], end)}
    assert "from_savings" not in kinds


def test_no_savings_option_when_savings_cannot_pay(twin):
    end = resolve_horizon_end(twin, None)
    kinds = {c.kind for c in generate_candidates(twin, [laptop(amount=1500.01)], end)}
    assert "from_savings" not in kinds
    kinds = {c.kind for c in generate_candidates(twin, [laptop(amount=1500)], end)}
    assert "from_savings" in kinds


def test_no_discretionary_spending_means_no_spending_cut(twin):
    groceries_only = twin.model_copy(
        update={"variable_spending": [v for v in twin.variable_spending if v.category == "groceries"]}
    )
    end = resolve_horizon_end(groceries_only, None)
    kinds = {c.kind for c in generate_candidates(groceries_only, [laptop()], end)}
    assert "reduce_spending" not in kinds


def test_spending_cut_scales_only_that_category(twin):
    end = resolve_horizon_end(twin, None)
    cut = next(c for c in generate_candidates(twin, [laptop()], end) if c.kind == "reduce_spending")
    adjusted = {v.category: v for v in adjusted_twin(twin, cut.spending_adjustments).variable_spending}
    original = {v.category: v for v in twin.variable_spending}
    m = cut.spending_adjustments[0].multiplier
    assert adjusted["discretionary"].mean_14d == pytest.approx(original["discretionary"].mean_14d * m)
    assert adjusted["discretionary"].std_dev_14d == pytest.approx(original["discretionary"].std_dev_14d * m)
    assert adjusted["groceries"] == original["groceries"]


def with_discretionary_profile(twin, factors: dict[int, float] | None):
    """Pin discretionary to $110 per 14 days with this profile, whatever the fixture holds."""
    assert twin.as_of == date(2026, 9, 19)  # the horizons below are written against this date
    profile = SeasonalProfile(factors=factors) if factors is not None else None
    spending = [
        v.model_copy(update={"mean_14d": 110.0, "seasonal": profile})
        if v.category == "discretionary"
        else v
        for v in twin.variable_spending
    ]
    return twin.model_copy(update={"variable_spending": spending})


def cut_details(twin, horizon_end: date) -> list[str]:
    return [
        c.detail
        for c in generate_candidates(twin, [laptop()], horizon_end)
        if c.kind == "reduce_spending"
    ]


AUTUMN_HEAVY = {m: 1.5 if m >= 9 else 0.5 if m <= 4 else 1.0 for m in range(1, 13)}
AUTUMN_LIGHT = {m: 0.5 if m >= 9 else 1.5 if m <= 4 else 1.0 for m in range(1, 13)}
AUTUMN_HEAVY_PROFILE = SeasonalProfile(factors=AUTUMN_HEAVY)


def test_spending_cut_quotes_the_annual_average_without_a_seasonal_profile(twin):
    flat = with_discretionary_profile(twin, None)
    end = resolve_horizon_end(flat, None)
    assert cut_details(flat, end) == [
        f"Discretionary spending averages $82 per 14 days instead of $110, through {end}.",
        f"Discretionary spending averages $55 per 14 days instead of $110, through {end}.",
    ]


def test_spending_cut_quotes_a_busy_season_average_over_a_busy_horizon(twin):
    end = twin.as_of + timedelta(days=28)  # all September and October
    details = cut_details(with_discretionary_profile(twin, AUTUMN_HEAVY), end)
    assert details == [
        f"Discretionary spending averages $124 per 14 days instead of $165, through {end}.",
        f"Discretionary spending averages $82 per 14 days instead of $165, through {end}.",
    ]


def test_spending_cut_quotes_a_quiet_season_average_over_a_quiet_horizon(twin):
    end = twin.as_of + timedelta(days=28)
    details = cut_details(with_discretionary_profile(twin, AUTUMN_LIGHT), end)
    assert details[0].endswith(f"instead of $55, through {end}.")


def test_spending_cut_quote_matches_the_simulated_average_across_seasons(twin):
    # The default horizon runs into 2027-05-01: busy autumn, quiet winter, a flat spring day.
    end = resolve_horizon_end(twin, None)
    seasonal = with_discretionary_profile(twin, AUTUMN_HEAVY)
    days = (end - twin.as_of).days
    expected = sum(
        110 * block_factor(AUTUMN_HEAVY_PROFILE, block[0], len(block)) * len(block) / 14
        for block in spending_blocks(twin.as_of, end)
    ) / days * 14
    assert expected != pytest.approx(110)
    assert cut_details(seasonal, end)[0].endswith(f"instead of {money(expected)}, through {end}.")


def test_unknown_account_is_rejected(twin):
    with pytest.raises(SimulationError):
        optimize(twin, laptop(account="acc_nope"))


# --- scoring and ranking ------------------------------------------------------


def test_every_candidate_shares_the_same_futures(twin):
    """Delaying or moving the purchase leaves the money spent by the goal deadline unchanged,
    so on shared futures the goal odds match buying now exactly."""
    result = optimize(twin)
    by_kind = {c.kind: c for c in result.candidates}
    buy_now = by_kind["buy_now"].metrics.prob_goal_met
    for c in result.candidates:
        if c.kind in ("delay", "from_savings"):
            assert c.metrics.prob_goal_met == buy_now


def test_candidates_are_ranked_constraints_first(twin):
    result = optimize(twin)
    kept = [c.meets_constraints for c in result.candidates]
    assert kept == sorted(kept, reverse=True)


def test_recommendation_is_the_first_option_that_keeps_every_limit(twin):
    result = optimize(twin)
    first_ok = next((c for c in result.candidates if c.meets_constraints), None)
    assert result.recommended_id == (first_ok.id if first_ok else None)


def test_baseline_is_the_future_without_the_purchase(twin):
    result = optimize(twin)
    unadjusted = [c for c in result.candidates if not c.spending_adjustments]
    assert all(result.baseline.prob_goal_met >= c.metrics.prob_goal_met for c in unadjusted)


def test_unaffordable_purchase_breaks_every_limit(twin):
    result = optimize(twin, laptop(amount=5000))
    assert result.recommended_id is None
    assert all(not c.meets_constraints and c.violations for c in result.candidates)
    assert "None of the" in result.summary


def test_declared_minimum_checking_balance_is_a_hard_limit(twin):
    metrics = optimize(twin).candidates[0].metrics.model_copy(
        update={"prob_low_balance": 0.5, "prob_below_reserve": 0, "prob_obligations_uncovered": 0}
    )
    assert check_constraints(twin, metrics) == []
    floor = FinancialConstraint(
        id="c", type="minimum_checking_balance", amount=300, description="Keep $300 in checking."
    )
    floor_twin = twin.model_copy(update={"constraints": [*twin.constraints, floor]})
    assert len(check_constraints(floor_twin, metrics)) == 1


def test_a_limit_the_baseline_already_breaks_only_counts_if_made_worse(twin):
    base = optimize(twin).baseline.model_copy(
        update={"prob_below_reserve": 0.3, "prob_obligations_uncovered": 0}
    )
    assert len(check_constraints(twin, base)) == 1
    assert check_constraints(twin, base, base) == []
    worse = base.model_copy(update={"prob_below_reserve": 0.4})
    [violation] = check_constraints(twin, worse, base)
    assert "up from 30%" in violation


def test_purchase_is_not_blamed_for_a_limit_already_broken_without_it(twin):
    reserve = FinancialConstraint(
        id="con_emergency_reserve", type="minimum_reserve", amount=10_000,
        description="Keep $10,000 across checking and savings.",
    )
    big_reserve = twin.model_copy(update={"constraints": [reserve]})
    result = optimize(big_reserve)
    assert result.baseline.prob_below_reserve == 1
    assert result.recommended_id is not None
    assert "Even without the purchase" in result.summary
    assert "None of the" not in result.summary


def test_paying_from_savings_breaks_a_limit_when_savings_already_covered_rent(twin):
    # No income and empty checking: October rent comes out of savings, so by 10-02
    # savings can no longer cover the $800 laptop even though it could on the start date.
    accounts = [a.model_copy(update={"balance": 0.0 if a.type == "checking" else 900.0})
                for a in twin.accounts]
    broke = twin.model_copy(update={"accounts": accounts, "income": []})
    result = optimize(broke, laptop(day=date(2026, 10, 2)))
    from_savings = next(c for c in result.candidates if c.kind == "from_savings")
    assert not from_savings.meets_constraints
    assert "Savings would have to go below $0" in from_savings.violations[0]


def buy_now_summary(twin, other_reserve_risk: float) -> str:
    result = optimize(twin)
    by_kind = {c.kind: c for c in result.candidates}
    buy_now = by_kind["buy_now"].model_copy(update={
        "meets_constraints": True, "violations": [],
        "metrics": by_kind["buy_now"].metrics.model_copy(
            update={"prob_goal_met": 0.9, "prob_below_reserve": 0.04}),
    })
    wait = by_kind["delay"].model_copy(update={
        "meets_constraints": True, "violations": [],
        "metrics": by_kind["delay"].metrics.model_copy(
            update={"prob_goal_met": 0.85, "prob_below_reserve": other_reserve_risk}),
    })
    return build_optimization_summary(twin, result.baseline, buy_now, buy_now, [buy_now, wait], [])


def test_buy_now_summary_names_a_safer_option_with_a_lower_goal_chance(twin):
    summary = buy_now_summary(twin, other_reserve_risk=0.01)
    assert "scores better" not in summary
    assert "no other option that does has a better chance of meeting the goal" in summary
    assert "lowers the chance of dipping below the reserve to 1% (buying now: 4%)" in summary
    assert "85%" in summary


def test_buy_now_summary_has_no_tradeoff_when_nothing_is_safer(twin):
    assert "lowers the chance" not in buy_now_summary(twin, other_reserve_risk=0.04)


def test_summary_names_the_first_ranked_option_without_picking_it(twin):
    result = optimize(twin)
    first = next(c for c in result.candidates if c.id == result.recommended_id)
    assert first.kind != "buy_now"
    assert f'none has a better chance of meeting the goal than "{first.label}"' in result.summary


@pytest.mark.parametrize("amount", [800.0, 5000.0])
def test_summary_does_not_tell_the_user_what_to_do(twin, amount):
    summaries = [optimize(twin, laptop(amount=amount)).summary, buy_now_summary(twin, 0.01)]
    for summary in summaries:
        lowered = summary.lower()
        assert not any(word in lowered for word in ("best", "recommend", "should", "choose", "pick"))


def test_fixed_seed_is_repeatable(twin):
    a = optimize(twin).model_dump(exclude={"optimization_id"})
    b = optimize(twin).model_dump(exclude={"optimization_id"})
    assert a == b


# --- API ----------------------------------------------------------------------

LAPTOP_REQUEST = {
    "user_id": "alex",
    "events": [
        {
            "type": "purchase",
            "description": "Laptop",
            "amount": 800,
            "date": "2026-09-20",
            "account_id": "acc_checking",
        }
    ],
}


def test_optimize_endpoint_returns_ranked_options():
    response = client.post("/optimize", json=LAPTOP_REQUEST)
    assert response.status_code == 200
    result = OptimizationResponse.model_validate(response.json())
    assert result.user_id == "alex"
    assert {c.kind for c in result.candidates} == {"buy_now", "delay", "reduce_spending", "from_savings"}
    assert result.summary and result.assumptions


def test_optimize_endpoint_rejects_unknown_account():
    bad = {**LAPTOP_REQUEST, "events": [{**LAPTOP_REQUEST["events"][0], "account_id": "acc_nope"}]}
    assert client.post("/optimize", json=bad).status_code == 422


def test_optimize_endpoint_rejects_unknown_user():
    assert client.post("/optimize", json={**LAPTOP_REQUEST, "user_id": "bob"}).status_code == 404
