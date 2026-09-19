from datetime import date

import pytest

from backend.fixtures import load_twin
from backend.schemas import ForecastMetadata, SeasonalProfile, SimulationEvent, SimulationRequest
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
        "Spending figures are fitted to 26 fortnights of observed spending, 2025-09-19 to 2026-09-18; "
        "recent fortnights count more, and one 180 days older counts half as much."
    ]


def test_equal_weighting_is_stated_when_there_is_no_half_life():
    twin = load_twin().model_copy(update={"forecast": forecast(half_life_days=None)})

    assert forecast_assumptions(twin)[0].endswith("every fortnight counts equally.")


def test_seasonal_category_names_its_busiest_and_quietest_months():
    text = seasonal_assumption("groceries", SeasonalProfile(factors=TERM_START))

    assert text == (
        "Groceries spending is highest in August and September (1.30× an average fortnight) "
        "and lowest in December (0.80×)."
    )


def test_flat_profile_says_nothing():
    assert seasonal_assumption("groceries", SeasonalProfile(factors=FLAT)) is None


def test_seasonal_twin_explains_the_pattern_and_the_flat_categories():
    twin = with_groceries_seasonal(TERM_START)
    assert len(twin.variable_spending) > 1

    lines = forecast_assumptions(twin)

    assert lines[1].startswith("A category with a seasonal pattern has its average and spread scaled")
    assert lines[2].startswith("Groceries spending is highest in August and September")
    assert lines[3] == "Every other spending category is flat across the year."


def test_simulation_assumptions_include_the_forecast():
    twin = with_groceries_seasonal(TERM_START)
    laptop = SimulationEvent(
        type="purchase", description="Laptop", amount=800, date=date(2026, 9, 20), account_id="acc_checking"
    )
    request = SimulationRequest(user_id="alex", events=[laptop])

    assumptions = run_simulation(twin, request, n_simulations=20, seed=1).assumptions

    assert any(a.startswith("Groceries spending is highest in") for a in assumptions)
    assert any(a.startswith("Spending figures are fitted to 26 fortnights") for a in assumptions)


# --- Seasonal timing of the purchase --------------------------------------------

LAPTOP = SimulationEvent(
    type="purchase", description="Laptop", amount=800, date=date(2026, 9, 20), account_id="acc_checking"
)
HORIZON = date(2027, 5, 1)
SEPTEMBER_BUSY = {**FLAT, 9: 1.3, 3: 0.7}  # averages 1.0
SEPTEMBER_QUIET = {**FLAT, 9: 0.7, 3: 1.3}


def test_a_flat_twin_gets_no_timing_driver(flat_twin):
    twin = flat_twin

    assert seasonal_timing_driver(twin, [LAPTOP], HORIZON) is None
    drivers = run_simulation(twin, SimulationRequest(user_id="alex", events=[LAPTOP]), n_simulations=20, seed=1).drivers
    assert not any("stretch" in d.label for d in drivers)


def test_window_spending_scales_only_the_seasonal_category():
    twin = with_groceries_seasonal(SEPTEMBER_BUSY)

    # 2026-09-20 to 2026-10-03: eleven September days at 1.3x, three October days at 1.0x.
    spending = window_spending(twin, date(2026, 9, 20), date(2026, 10, 3))

    assert spending["groceries"] == pytest.approx((150 * (11 * 1.3 + 3) / 14, 150))
    assert spending["discretionary"] == pytest.approx((110, 110))


def test_a_purchase_before_a_busy_stretch_is_pointed_out():
    driver = seasonal_timing_driver(with_groceries_seasonal(SEPTEMBER_BUSY), [LAPTOP], HORIZON)

    extra = 150 * (11 * 1.3 + 3) / 14 - 150
    assert driver.label == "Busy spending stretch"
    assert driver.direction == "negative"
    assert driver.impact_amount == pytest.approx(-extra, abs=0.01)
    assert driver.detail == (
        "The laptop on 2026-09-20 lands at the start of a busy stretch: everyday spending through "
        f"2026-10-03 is expected to be {money(260 + extra)}, versus $260 in an average stretch of the "
        "year (groceries 1.24× their usual). This happens with or without the purchase."
    )


def test_a_purchase_before_a_quiet_stretch_is_pointed_out():
    driver = seasonal_timing_driver(with_groceries_seasonal(SEPTEMBER_QUIET), [LAPTOP], HORIZON)

    assert driver.label == "Quiet spending stretch"
    assert driver.direction == "positive"
    assert driver.impact_amount > 0
    assert "(groceries 0.76× their usual)" in driver.detail


def test_a_small_seasonal_effect_says_nothing():
    slight = {**FLAT, 9: 1.04, 3: 0.96}

    assert seasonal_timing_driver(with_groceries_seasonal(slight), [LAPTOP], HORIZON) is None


def test_the_window_starts_at_the_earliest_purchase_and_stops_at_the_horizon():
    late = LAPTOP.model_copy(update={"date": date(2026, 9, 28)})
    early = LAPTOP.model_copy(update={"date": date(2026, 9, 20)})

    driver = seasonal_timing_driver(with_groceries_seasonal(SEPTEMBER_BUSY), [late, early], date(2026, 9, 25))

    # Six days, 2026-09-20 to 2026-09-25: $260 per 14 days on average, groceries at 1.3x.
    expected = (150 * 1.3 + 110) / 14 * 6
    assert f"through 2026-09-25 is expected to be {money(expected)}, versus $111" in driver.detail


def test_the_timing_driver_sits_between_the_goal_and_income_drivers():
    twin = with_groceries_seasonal(SEPTEMBER_BUSY)
    request = SimulationRequest(user_id="alex", events=[LAPTOP])

    labels = [d.label for d in run_simulation(twin, request, n_simulations=20, seed=1).drivers]

    assert labels[0] == "Laptop"
    assert labels[-2:] == ["Busy spending stretch", "Expected income"]


def test_the_demo_twin_explains_its_seasonal_spending():
    """Alex's fixture carries fitted profiles, so the demo shows the forecast work."""
    twin = load_twin()
    result = run_simulation(twin, SimulationRequest(user_id="alex", events=[LAPTOP]), n_simulations=20, seed=1)

    assert "Busy spending stretch" in [d.label for d in result.drivers]
    assert any(a.startswith("Discretionary spending is highest in December") for a in result.assumptions)
