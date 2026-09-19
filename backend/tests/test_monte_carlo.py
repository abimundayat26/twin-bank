import random
from datetime import date

import pytest

from backend.schemas import (
    OneTimeObligation,
    SeasonalProfile,
    SimulationEvent,
    SimulationRequest,
    VariableSpendingDistribution,
)
from backend.simulation import run_simulation
from backend.simulation.engine import SimulationError, compare, simulate_scenario
from backend.simulation.monte_carlo import (
    INCOME_CLAMP_SDS,
    MAX_SIMULATIONS,
    run_monte_carlo,
    sample_draws,
    sample_income,
    sample_spending,
    simulate_pairs,
)

HORIZON = date(2027, 5, 1)


def purchase(amount: float, on: str = "2026-09-20") -> SimulationEvent:
    return SimulationEvent(
        type="purchase", description="Laptop", amount=amount, date=date.fromisoformat(on), account_id="acc_checking"
    )


@pytest.fixture
def twin(flat_twin):
    # Hand-checked arithmetic below assumes flat 14-day spending.
    return flat_twin


def without_uncertainty(twin):
    return twin.model_copy(
        update={
            "income": [s.model_copy(update={"uncertainty": 0.0}) for s in twin.income],
            "variable_spending": [v.model_copy(update={"std_dev_14d": 0.0}) for v in twin.variable_spending],
        }
    )


# --- Reproducibility -----------------------------------------------------------


def test_fixed_seed_is_repeatable(twin):
    first = run_monte_carlo(twin, [purchase(800)], n_simulations=200, seed=42)
    assert run_monte_carlo(twin, [purchase(800)], n_simulations=200, seed=42) == first
    assert run_monte_carlo(twin, [purchase(800)], n_simulations=200, seed=43) != first


def test_seeded_response_is_repeatable_apart_from_id(twin):
    request = SimulationRequest(user_id="alex", events=[purchase(800)])
    a = run_simulation(twin, request, n_simulations=100, seed=7)
    b = run_simulation(twin, request, n_simulations=100, seed=7)
    assert a.model_dump(exclude={"simulation_id"}) == b.model_dump(exclude={"simulation_id"})


# --- Agreement with the deterministic engine -------------------------------------


def test_zero_uncertainty_matches_deterministic_engine(twin):
    certain = without_uncertainty(twin)
    mc = run_monte_carlo(certain, [purchase(800)], n_simulations=20, seed=1)
    expected = compare(certain, [purchase(800)])
    for agg, result in [(mc.baseline, expected.baseline), (mc.counterfactual, expected.counterfactual)]:
        assert agg.ending_balance == pytest.approx(result.ending_balance, abs=0.01)
        assert agg.ending_balance_p10 == pytest.approx(result.ending_balance, abs=0.01)
        assert agg.ending_balance_p90 == pytest.approx(result.ending_balance, abs=0.01)
        assert agg.min_balance == pytest.approx(result.min_balance, abs=0.01)
        assert agg.min_checking == pytest.approx(result.min_checking, abs=0.01)
        assert agg.goal_shortfall == pytest.approx(result.goal_shortfall, abs=0.01)
        assert agg.prob_low_balance == float(result.dropped_below_low)
        assert agg.prob_below_reserve == float(result.reserve_violated)
        assert agg.prob_obligations_uncovered == float(not result.obligations_covered)


# --- Probabilities and aggregation ---------------------------------------------------


@pytest.mark.parametrize("amount", [50, 800, 1500, 3000])
def test_probabilities_are_between_0_and_1(twin, amount):
    mc = run_monte_carlo(twin, [purchase(amount)], n_simulations=100, seed=3)
    for agg in (mc.baseline, mc.counterfactual):
        probs = [agg.prob_low_balance, agg.prob_below_reserve, agg.prob_obligations_uncovered,
                 agg.prob_savings_sweep, agg.prob_goal_met]
        probs += [g.prob_met for g in agg.goals]
        assert all(0 <= p <= 1 for p in probs)
        assert agg.ending_balance_p10 <= agg.ending_balance <= agg.ending_balance_p90


@pytest.mark.parametrize("amount", [800, 1500, 3000])
def test_a_bill_savings_can_cover_is_a_sweep_and_not_an_uncovered_bill(twin, amount):
    """Emptying savings can only ever turn sweeps into uncovered bills, never the reverse."""
    drained = twin.model_copy(
        update={"accounts": [a.model_copy(update={"balance": 0.0}) if a.type == "savings" else a
                             for a in twin.accounts]}
    )
    with_savings = run_monte_carlo(twin, [purchase(amount)], n_simulations=100, seed=7).counterfactual
    without = run_monte_carlo(drained, [purchase(amount)], n_simulations=100, seed=7).counterfactual
    assert with_savings.prob_obligations_uncovered <= without.prob_obligations_uncovered


def test_simulation_count_is_configurable(twin):
    pairs = list(simulate_pairs(twin, [purchase(800)], HORIZON, 50, random.Random(0)))
    assert len(pairs) == 50
    mc = run_monte_carlo(twin, [purchase(800)], n_simulations=50, seed=0)
    assert mc.n_simulations == 50
    for p in (mc.counterfactual.prob_below_reserve, mc.counterfactual.prob_goal_met):
        assert (p * 50) == pytest.approx(round(p * 50))


@pytest.mark.parametrize("n", [0, -1, MAX_SIMULATIONS + 1, 2.5, True])
def test_invalid_simulation_counts_are_rejected(twin, n):
    with pytest.raises(SimulationError):
        run_monte_carlo(twin, [purchase(800)], n_simulations=n)


def test_invalid_events_are_still_rejected(twin):
    with pytest.raises(SimulationError):
        run_monte_carlo(twin, [purchase(800, on="2026-09-01")], n_simulations=10)


# --- Common random numbers ----------------------------------------------------------


def test_baseline_and_counterfactual_share_sampled_conditions(twin):
    expected = compare(twin, [purchase(800)]).baseline
    varied = False
    for draws, base, cf in simulate_pairs(twin, [purchase(800)], HORIZON, 50, random.Random(5)):
        # Same sampled future: re-running the baseline on these draws reproduces it,
        # income is identical, and the purchase is the only difference.
        assert base == simulate_scenario(twin, [], HORIZON, draws)
        assert cf.total_income == base.total_income
        assert cf.ending_balance == pytest.approx(base.ending_balance - 800, abs=0.01)
        varied |= base.ending_balance != expected.ending_balance
    assert varied, "draws should differ from the expected-value path"


# --- Alex scenarios -------------------------------------------------------------------


def test_laptop_increases_downside(twin):
    mc = run_monte_carlo(twin, [purchase(800)], seed=11)
    base, cf = mc.baseline, mc.counterfactual
    assert cf.ending_balance < base.ending_balance
    assert cf.prob_low_balance > base.prob_low_balance + 0.5
    assert cf.prob_below_reserve >= base.prob_below_reserve
    assert cf.prob_goal_met < base.prob_goal_met - 0.3
    assert cf.goal_shortfall > base.goal_shortfall == 0
    # Baseline goal is likely but not certain once income and spending vary.
    assert 0.5 < base.prob_goal_met < 1


def test_large_purchase_raises_reserve_violation_probability(twin):
    mc = run_monte_carlo(twin, [purchase(1500)], n_simulations=300, seed=12)
    assert mc.baseline.prob_below_reserve < 0.05
    assert mc.counterfactual.prob_below_reserve > 0.9


# --- Sampling bounds ------------------------------------------------------------------


def test_sampled_spending_is_never_negative():
    rng = random.Random(0)
    samples = [sample_spending(rng, 10, 1000) for _ in range(2000)]
    assert min(samples) == 0
    assert all(s >= 0 for s in samples)


def test_sampled_income_is_clamped():
    rng = random.Random(0)
    samples = [sample_income(rng, 100, 1000) for _ in range(2000)]
    assert all(0 <= s <= 100 + INCOME_CLAMP_SDS * 1000 for s in samples)
    rng = random.Random(0)
    samples = [sample_income(rng, 720, 60) for _ in range(2000)]
    assert all(720 - 3 * 60 <= s <= 720 + 3 * 60 for s in samples)


def test_sampled_daily_spending_is_never_negative(twin):
    volatile = twin.model_copy(
        update={
            "variable_spending": [VariableSpendingDistribution(category="volatile", mean_14d=10, std_dev_14d=500)]
        }
    )
    draws = sample_draws(volatile, HORIZON, random.Random(0))
    assert len(draws.daily_spending) == (HORIZON - twin.as_of).days
    assert all(x >= 0 for x in draws.daily_spending.values())


def test_response_carries_monte_carlo_fields(twin):
    request = SimulationRequest(user_id="alex", events=[purchase(800)])
    response = run_simulation(twin, request, n_simulations=200, seed=4)
    mc = run_monte_carlo(twin, [purchase(800)], n_simulations=200, seed=4)
    assert response.num_simulations == 200
    for metrics, agg in [(response.baseline, mc.baseline), (response.counterfactual, mc.counterfactual)]:
        assert metrics.prob_goal_met == agg.prob_goal_met
        assert metrics.prob_obligations_uncovered == agg.prob_obligations_uncovered
        assert metrics.obligations_covered == (agg.prob_obligations_uncovered == 0)


# --- Seasonal spending ----------------------------------------------------------------

TERM_SHAPE = {m: 1.5 if m >= 9 else 0.5 if m <= 4 else 1.0 for m in range(1, 13)}


def with_profile(twin, factors: dict[int, float]):
    profile = SeasonalProfile(factors=factors)
    return twin.model_copy(
        update={"variable_spending": [v.model_copy(update={"seasonal": profile}) for v in twin.variable_spending]}
    )


def test_a_flat_profile_draws_exactly_what_no_profile_draws(twin):
    flat = with_profile(twin, dict.fromkeys(range(1, 13), 1.0))
    assert sample_draws(flat, HORIZON, random.Random(3)) == sample_draws(twin, HORIZON, random.Random(3))


def test_zero_uncertainty_seasonal_matches_deterministic_engine(twin):
    certain = with_profile(without_uncertainty(twin), TERM_SHAPE)
    mc = run_monte_carlo(certain, [purchase(800)], n_simulations=5, seed=1)
    expected = compare(certain, [purchase(800)])
    assert mc.baseline.ending_balance == pytest.approx(expected.baseline.ending_balance, abs=0.01)
    assert mc.counterfactual.ending_balance == pytest.approx(expected.counterfactual.ending_balance, abs=0.01)
    assert mc.baseline.min_checking == pytest.approx(expected.baseline.min_checking, abs=0.01)


def test_seasonal_factor_scales_the_spread_too(twin):
    # Nothing is spent July-December, however volatile the category is.
    idle_autumn = with_profile(twin, {m: 2.0 if m <= 6 else 0.0 for m in range(1, 13)})
    draws = sample_draws(idle_autumn, date(2026, 12, 31), random.Random(0))
    assert set(draws.daily_spending.values()) == {0.0}


# --- One-time obligations ------------------------------------------------------


def owing(twin, amount: float, due: str = "2026-11-10"):
    return twin.model_copy(
        update={
            "one_time_obligations": [
                OneTimeObligation(
                    id="one_tuition",
                    name="Tuition",
                    amount=amount,
                    due_date=date.fromisoformat(due),
                    account_id="acc_checking",
                )
            ]
        }
    )


def test_a_large_one_time_obligation_raises_the_chance_of_an_uncovered_bill(twin):
    # $3,000 is past what checking plus savings can absorb by November in most futures.
    without = run_monte_carlo(twin, [purchase(800)], n_simulations=200, seed=5)
    with_it = run_monte_carlo(owing(twin, 3000), [purchase(800)], n_simulations=200, seed=5)
    assert (
        with_it.baseline.prob_obligations_uncovered > without.baseline.prob_obligations_uncovered
    )
    assert (
        with_it.counterfactual.prob_obligations_uncovered
        > without.counterfactual.prob_obligations_uncovered
    )


def test_a_seeded_run_with_an_obligation_is_still_reproducible(twin):
    owed = owing(twin, 3000)
    first = run_monte_carlo(owed, [purchase(800)], n_simulations=200, seed=42)
    assert run_monte_carlo(owed, [purchase(800)], n_simulations=200, seed=42) == first


def test_an_obligation_is_in_both_runs_so_it_is_not_the_delta(twin):
    """It belongs to the baseline, so the purchase is still the only difference."""
    owed = owing(twin, 1000)
    plain = run_monte_carlo(twin, [purchase(800)], n_simulations=100, seed=9)
    with_it = run_monte_carlo(owed, [purchase(800)], n_simulations=100, seed=9)
    delta_plain = plain.baseline.ending_balance - plain.counterfactual.ending_balance
    delta_owed = with_it.baseline.ending_balance - with_it.counterfactual.ending_balance
    assert delta_owed == pytest.approx(delta_plain, abs=0.01)
