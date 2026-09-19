from backend.fixtures import load_raw_transactions, load_twin
from backend.ingest.build import latest_transaction_date, rebuild
from backend.ingest.normalize import normalize_all
from backend.tracking import twin_build_summary

PARAM_KEYS = {
    "user_id",
    "source",
    "method",
    "as_of",
    "window_start",
    "observed_fortnights",
    "half_life_days",
}


def built_twin():
    """Alex rebuilt from transactions.json, through the last transaction."""
    transactions = normalize_all(load_raw_transactions())
    return rebuild(load_twin(), transactions, latest_transaction_date(transactions))


def test_built_twin_params_describe_the_forecast():
    params, _ = twin_build_summary(built_twin())
    assert params == {
        "user_id": "alex",
        "source": "none",
        "method": "seasonal_ewma",
        "as_of": "2026-09-18",
        "window_start": "2025-09-20",
        "observed_fortnights": "25",
        "half_life_days": "180.0",
    }


def test_built_twin_metrics_match_its_seasonal_profiles():
    twin = built_twin()
    _, metrics = twin_build_summary(twin)
    seasonal = [v for v in twin.variable_spending if v.seasonal is not None]
    assert seasonal
    for spending in seasonal:
        factors = spending.seasonal.factors.values()
        assert metrics[f"{spending.category}.seasonal_max"] == max(factors) > 1
        assert metrics[f"{spending.category}.seasonal_min"] == min(factors) < 1
    for spending in twin.variable_spending:
        assert metrics[f"{spending.category}.mean_14d"] == spending.mean_14d
        assert metrics[f"{spending.category}.std_dev_14d"] == spending.std_dev_14d
    assert metrics["income_streams"] == len(twin.income)
    assert metrics["obligations"] == len(twin.obligations)


def test_flat_twin_has_no_seasonal_metrics(flat_twin):
    _, metrics = twin_build_summary(flat_twin)
    assert not [key for key in metrics if ".seasonal_" in key]
    assert f"{flat_twin.variable_spending[0].category}.mean_14d" in metrics


def test_twin_without_forecast_keeps_every_param():
    twin = load_twin().model_copy(update={"forecast": None})
    params, _ = twin_build_summary(twin)
    assert set(params) == PARAM_KEYS
    for key in PARAM_KEYS - {"user_id"}:
        assert params[key] == "none", key


def test_values_are_strings_and_floats(flat_twin):
    for twin in (built_twin(), flat_twin):
        params, metrics = twin_build_summary(twin)
        assert all(type(value) is str for value in params.values())
        assert all(type(value) is float for value in metrics.values())
