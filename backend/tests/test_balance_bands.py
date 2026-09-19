from datetime import date, timedelta

from backend.fixtures import load_twin
from backend.schemas import SimulationEvent, SimulationRequest
from backend.simulation import run_simulation
from backend.simulation.monte_carlo import run_monte_carlo

LAPTOP = SimulationEvent(
    type="purchase",
    description="Laptop",
    amount=800.0,
    date=date(2026, 9, 20),
    account_id="acc_checking",
)


def test_bands_are_off_by_default():
    mc = run_monte_carlo(load_twin(), [LAPTOP], n_simulations=20, seed=1)
    assert mc.baseline_bands is None
    assert mc.counterfactual_bands is None


def test_bands_cover_every_day_from_as_of_to_horizon():
    twin = load_twin()
    mc = run_monte_carlo(twin, [LAPTOP], n_simulations=50, seed=1, bands=True)
    bands = mc.counterfactual_bands
    days = (mc.horizon_end - twin.as_of).days + 1
    assert bands.dates == [twin.as_of + timedelta(days=i) for i in range(days)]
    for series in (bands.total, bands.checking):
        assert len(series.p10) == len(series.median) == len(series.p90) == days
        assert all(lo <= mid <= hi for lo, mid, hi in zip(series.p10, series.median, series.p90))


def test_bands_do_not_change_the_metrics():
    twin = load_twin()
    plain = run_monte_carlo(twin, [LAPTOP], n_simulations=50, seed=5)
    banded = run_monte_carlo(twin, [LAPTOP], n_simulations=50, seed=5, bands=True)
    assert banded.baseline == plain.baseline
    assert banded.counterfactual == plain.counterfactual


def test_bands_start_at_todays_balance_and_end_at_the_median_ending_balance():
    twin = load_twin()
    mc = run_monte_carlo(twin, [LAPTOP], n_simulations=50, seed=2, bands=True)
    for bands, aggregate in ((mc.baseline_bands, mc.baseline), (mc.counterfactual_bands, mc.counterfactual)):
        assert bands.total.p10[0] == bands.total.p90[0] == twin.total_balance
        assert bands.total.median[-1] == aggregate.ending_balance


def test_purchase_lowers_the_counterfactual_band_after_its_date():
    mc = run_monte_carlo(load_twin(), [LAPTOP], n_simulations=50, seed=3, bands=True)
    day = mc.counterfactual_bands.dates.index(LAPTOP.date)
    gap = mc.baseline_bands.total.median[day] - mc.counterfactual_bands.total.median[day]
    assert round(gap, 2) == LAPTOP.amount


def test_simulation_response_carries_bands():
    twin = load_twin()
    request = SimulationRequest(user_id="alex", events=[LAPTOP])
    response = run_simulation(twin, request, n_simulations=30, seed=1)
    bands = response.balance_bands
    assert bands is not None
    assert bands.baseline.total[0].date == twin.as_of
    assert bands.counterfactual.checking[-1].date == response.horizon_end
    assert bands.counterfactual.total[-1].median == response.counterfactual.ending_balance
