from datetime import date

from backend.fixtures import load_twin
from backend.schemas import ForecastMetadata, SeasonalProfile, SimulationEvent, SimulationRequest
from backend.simulation import run_simulation
from backend.simulation.explain import forecast_assumptions, seasonal_assumption

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
        v.model_copy(update={"seasonal": SeasonalProfile(factors=factors)}) if v.category == "groceries" else v
        for v in twin.variable_spending
    ]
    return twin.model_copy(update={"variable_spending": spending, "forecast": forecast()})


def test_twin_without_a_forecast_adds_nothing():
    twin = load_twin()
    assert twin.forecast is None
    assert all(v.seasonal is None for v in twin.variable_spending)

    assert forecast_assumptions(twin) == []


def test_forecast_window_and_recency_weighting_are_stated():
    twin = load_twin().model_copy(update={"forecast": forecast()})

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
