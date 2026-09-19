"""A built twin, summarized as flat params and metrics for experiment tracking.

Phase 6 records every twin build so that a change to the forecaster can be
compared run against run. This module only decides what gets recorded; the
tracking itself (MLflow, behind a flag) arrives in later chunks.

The summary describes the estimate, not the person: which method produced the
observed figures, over what window, and what it fitted per category. Balances,
goals and constraints are left out on purpose. They are reported or declared,
not estimated (SPEC section 2), so they say nothing about how well the
forecaster did — and they are the parts of a twin most worth keeping private.

Params are strings and metrics are floats, the shapes a tracker expects. A
missing value is recorded as "none" rather than dropped, so every run carries
the same keys and runs line up when compared.
"""

from datetime import date

from backend.schemas import FinancialTwin

MISSING = "none"


def as_param(value: object) -> str:
    """A param value as a stable string: ISO dates, and "none" for missing."""
    if value is None:
        return MISSING
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def twin_build_summary(twin: FinancialTwin) -> tuple[dict[str, str], dict[str, float]]:
    """`(params, metrics)` describing how the twin's observed figures were estimated."""
    forecast = twin.forecast
    params = {
        "user_id": as_param(twin.user_id),
        "source": as_param(twin.source),
        "method": as_param(forecast and forecast.method),
        "as_of": as_param(forecast and forecast.as_of),
        "window_start": as_param(forecast and forecast.window_start),
        "observed_fortnights": as_param(forecast and forecast.observed_fortnights),
        "half_life_days": as_param(forecast and forecast.half_life_days),
    }

    metrics: dict[str, float] = {}
    for spending in twin.variable_spending:
        metrics[f"{spending.category}.mean_14d"] = float(spending.mean_14d)
        metrics[f"{spending.category}.std_dev_14d"] = float(spending.std_dev_14d)
        # Flat categories get no seasonal keys: there is no shape to record.
        if spending.seasonal is not None:
            factors = spending.seasonal.factors.values()
            metrics[f"{spending.category}.seasonal_max"] = float(max(factors))
            metrics[f"{spending.category}.seasonal_min"] = float(min(factors))
    metrics["income_streams"] = float(len(twin.income))
    metrics["obligations"] = float(len(twin.obligations))
    return params, metrics
