from datetime import date, timedelta

import pytest

from backend.fixtures import load_twin
from backend.schemas import (
    ForecastMetadata,
    OneTimeObligation,
    SeasonalProfile,
    SimulationEvent,
    SimulationRequest,
)
from backend.simulation import run_simulation
from backend.simulation.explain import (
    forecast_assumptions,
    money,
    seasonal_assumption,
    seasonal_timing_driver,
    window_spending,
)

FLAT = {month: 1.0 for month in range(1, 13)}
TERM_START = {**FLAT, 8: 1.3, 9: 1.3, 6: 0.85, 7: 0.85, 12: 0.8}  # averages 1.0

# Read off the fixture rather than typed in. What these tests check is how the
# seasonal factors scale a fortnightly average, which is the same arithmetic
# whatever that average happens to be; hard-coding it only means the test breaks
# every time the twin is rebuilt.
MEANS = {v.category: v.mean_14d for v in load_twin().variable_spending}
GROCERIES, DISCRETIONARY = MEANS["groceries"], MEANS["discretionary"]
EVERYDAY = GROCERIES + DISCRETIONARY


def forecast(half_life_days: float | None = 180.0) -> ForecastMetadata:
    return ForecastMetadata(
        method="seasonal_ewma",
        as_of=date(2026, 9, 18),
        window_start=date(2025, 9, 19),
        observed_fortnights=26,
        half_life_days=half_life_days,
    )


def with_groceries_seasonal(factors: dict[int, float]):
    twin = load_twin()
    spending = [
        v.model_copy(update={"seasonal": SeasonalProfile(factors=factors) if v.category == "groceries" else None})
        for v in twin.variable_spending
    ]
    return twin.model_copy(update={"variable_spending": spending, "forecast": forecast()})


def test_twin_without_a_forecast_adds_nothing(flat_twin):
    twin = flat_twin
    assert twin.forecast is None
    assert all(v.seasonal is None for v in twin.variable_spending)

    assert forecast_assumptions(twin) == []


def test_forecast_window_and_recency_weighting_are_stated(flat_twin):
    twin = flat_twin.model_copy(update={"forecast": forecast()})

    assert forecast_assumptions(twin) == [
        "Spending estimates use 26 two-week periods observed from 2025-09-19 to 2026-09-18. "
        "Recent periods count more; a period 180 days older gets half the weight."
    ]


def test_equal_weighting_is_stated_when_there_is_no_half_life():
    twin = load_twin().model_copy(update={"forecast": forecast(half_life_days=None)})

    assert forecast_assumptions(twin)[0].endswith("All periods count equally.")


def test_seasonal_category_names_its_busiest_and_quietest_months():
    text = seasonal_assumption("groceries", SeasonalProfile(factors=TERM_START))

    assert text == (
        "Groceries spending is usually highest in August and September "
        "(1.30× its typical two-week amount) and lowest in December (0.80×)."
    )


def test_flat_profile_says_nothing():
    assert seasonal_assumption("groceries", SeasonalProfile(factors=FLAT)) is None


def test_seasonal_twin_explains_the_pattern_and_the_flat_categories():
    twin = with_groceries_seasonal(TERM_START)
    assert len(twin.variable_spending) > 1

    lines = forecast_assumptions(twin)

    assert lines[1].startswith("Seasonal categories adjust their typical spending")
    assert lines[2].startswith("Groceries spending is usually highest in August and September")
    assert lines[3] == "Every other spending category is flat across the year."


def test_simulation_assumptions_include_the_forecast():
    twin = with_groceries_seasonal(TERM_START)
    laptop = SimulationEvent(
        type="purchase", description="Laptop", amount=800, date=date(2026, 9, 20), account_id="acc_checking"
    )
    request = SimulationRequest(user_id="alex", events=[laptop])

    assumptions = run_simulation(twin, request, n_simulations=20, seed=1).assumptions

    assert any(a.startswith("Groceries spending is usually highest in") for a in assumptions)
    assert any(a.startswith("Spending estimates use 26 two-week periods") for a in assumptions)


# --- Seasonal timing of the purchase --------------------------------------------

LAPTOP = SimulationEvent(
    type="purchase", description="Laptop", amount=800, date=date(2026, 9, 20), account_id="acc_checking"
)
HORIZON = date(2027, 5, 1)
SEPTEMBER_BUSY = {**FLAT, 9: 1.3, 3: 0.7}  # averages 1.0
SEPTEMBER_QUIET = {**FLAT, 9: 0.7, 3: 1.3}

# Spending is projected in 14-day blocks anchored to the twin's as_of, and each
# block carries one factor: the average of its days'. So the arithmetic below
# follows the blocks, not the calendar.
BLOCK_START = load_twin().as_of + timedelta(days=1)  # 2026-09-19
BLOCK_END = BLOCK_START + timedelta(days=13)  # 2026-10-02
BUSY_BLOCK = (12 * 1.3 + 2) / 14  # twelve September days at 1.3x, two October at 1.0x

# The laptop's own fortnight, 2026-09-20 to 2026-10-03, is a day out of step with
# those blocks: thirteen of its days fall in the busy first block and the last
# one in the flat October block that follows.
BUSY_FORTNIGHT = (13 * BUSY_BLOCK + 1.0) / 14


def test_a_flat_twin_gets_no_timing_driver(flat_twin):
    twin = flat_twin

    assert seasonal_timing_driver(twin, [LAPTOP], HORIZON) is None
    drivers = run_simulation(twin, SimulationRequest(user_id="alex", events=[LAPTOP]), n_simulations=20, seed=1).drivers
    assert not any("stretch" in d.label for d in drivers)


def test_window_spending_scales_only_the_seasonal_category():
    twin = with_groceries_seasonal(SEPTEMBER_BUSY)

    # Exactly the first spending block, so one factor covers the whole window.
    spending = window_spending(twin, BLOCK_START, BLOCK_END)

    assert spending["groceries"] == pytest.approx((GROCERIES * BUSY_BLOCK, GROCERIES))
    assert spending["discretionary"] == pytest.approx((DISCRETIONARY, DISCRETIONARY))


def test_a_purchase_before_a_busy_stretch_is_pointed_out():
    driver = seasonal_timing_driver(with_groceries_seasonal(SEPTEMBER_BUSY), [LAPTOP], HORIZON)

    extra = GROCERIES * BUSY_FORTNIGHT - GROCERIES
    assert driver.label == "Busy spending stretch"
    assert driver.direction == "negative"
    assert driver.impact_amount == pytest.approx(-extra, abs=0.01)
    assert driver.detail == (
        "The laptop on 2026-09-20 lands at the start of a busy stretch: everyday spending through "
        f"2026-10-03 is expected to be {money(EVERYDAY + extra)}, versus {money(EVERYDAY)} in an "
        "average stretch of the year (groceries: 1.24× usual). This happens with or without the "
        "purchase."
    )


def test_a_purchase_before_a_quiet_stretch_is_pointed_out():
    driver = seasonal_timing_driver(with_groceries_seasonal(SEPTEMBER_QUIET), [LAPTOP], HORIZON)

    assert driver.label == "Quiet spending stretch"
    assert driver.direction == "positive"
    assert driver.impact_amount > 0
    assert "(groceries: 0.76× usual)" in driver.detail


def test_a_small_seasonal_effect_says_nothing():
    slight = {**FLAT, 9: 1.04, 3: 0.96}

    assert seasonal_timing_driver(with_groceries_seasonal(slight), [LAPTOP], HORIZON) is None


def test_the_window_starts_at_the_earliest_purchase_and_stops_at_the_horizon():
    late = LAPTOP.model_copy(update={"date": date(2026, 9, 28)})
    early = LAPTOP.model_copy(update={"date": date(2026, 9, 20)})

    driver = seasonal_timing_driver(with_groceries_seasonal(SEPTEMBER_BUSY), [late, early], date(2026, 9, 25))

    # Six days, 2026-09-20 to 2026-09-25. The horizon cuts the first block short
    # at 2026-09-25, so every day left in it is a September day at 1.3x.
    expected = (GROCERIES * 1.3 + DISCRETIONARY) / 14 * 6
    average = EVERYDAY / 14 * 6
    assert (
        f"through 2026-09-25 is expected to be {money(expected)}, versus {money(average)}"
        in driver.detail
    )


def test_the_timing_driver_sits_between_the_goal_and_income_drivers():
    twin = with_groceries_seasonal(SEPTEMBER_BUSY)
    request = SimulationRequest(user_id="alex", events=[LAPTOP])

    labels = [d.label for d in run_simulation(twin, request, n_simulations=20, seed=1).drivers]

    assert labels[0] == "Laptop (this purchase)"
    assert labels[-2:] == ["Busy spending stretch", "Expected income"]


def test_the_demo_twin_explains_its_seasonal_spending():
    """Alex's fixture carries fitted profiles, so the demo shows the forecast work."""
    twin = load_twin()
    result = run_simulation(twin, SimulationRequest(user_id="alex", events=[LAPTOP]), n_simulations=20, seed=1)

    assert "Busy spending stretch" in [d.label for d in result.drivers]
    assert any(a.startswith("Discretionary spending is usually highest in December") for a in result.assumptions)


# --- A declared commitment is not a hypothetical purchase -------------------------


def owing(twin, amount: float = 1200.0, due: str = "2026-11-10"):
    return twin.model_copy(
        update={
            "one_time_obligations": [
                OneTimeObligation(
                    id="one_tuition",
                    name="Tuition",
                    amount=amount,
                    due_date=date.fromisoformat(due),
                    account_id="acc_checking",
                    mandatory=True,
                )
            ]
        }
    )


def explain(twin, n: int = 20, seed: int = 1):
    return run_simulation(twin, SimulationRequest(user_id="alex", events=[LAPTOP]), n_simulations=n, seed=seed)


def test_a_commitment_and_a_purchase_are_never_described_the_same_way():
    drivers = {d.label: d.detail for d in explain(owing(load_twin())).drivers}
    [purchase] = [label for label in drivers if label.startswith("Laptop")]
    [commitment] = [label for label in drivers if label.startswith("Tuition")]
    assert purchase == "Laptop (this purchase)"
    assert commitment == "Tuition (already owed)"
    # The distinction is in the words, not in position or colour.
    assert "being simulated" in drivers[purchase]
    assert "one scenario only" in drivers[purchase]
    assert "commitment Alex declared" in drivers[commitment]
    assert "both scenarios" in drivers[commitment]
    # And the commitment is never described as something being considered.
    assert "purchase" not in drivers[commitment].replace(
        "not part of the difference the purchase makes", ""
    )


def test_the_summary_attributes_the_difference_to_the_purchase_alone():
    summary = explain(owing(load_twin())).summary
    assert "$1,200 of one-time commitment due before 2027-05-01" in summary
    assert "spent in both futures above" in summary
    assert "the change between them is the $800 laptop alone" in summary


def test_a_commitment_outside_the_horizon_is_neither_shown_nor_claimed():
    """It never happens in this run, so explaining it would be explaining nothing."""
    result = explain(owing(load_twin(), due="2027-09-01"))
    assert not [d for d in result.drivers if "Tuition" in d.label]
    assert "already declared" not in result.summary


def test_a_twin_with_no_commitments_explains_exactly_as_before():
    result = explain(load_twin())
    assert not [d for d in result.drivers if "already owed" in d.label]
    assert "already declared" not in result.summary
