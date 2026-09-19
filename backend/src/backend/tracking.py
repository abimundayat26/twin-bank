"""A built twin, summarized as flat params and metrics for experiment tracking.

Phase 6 records every twin build so that a change to the forecaster can be
compared run against run. `twin_build_summary` decides what gets recorded and is
pure; `log_twin_build` sends it to MLflow, and only when `TRACK_TWIN_BUILDS` is
on. It is called wherever a twin is built from transactions: `POST /twin/build`
and each Nessie build in `twin_source`. The hand-written fixture twin is not a
build, so serving it logs nothing.

The summary describes the estimate, not the person: which method produced the
observed figures, over what window, and what it fitted per category. Balances,
goals and constraints are left out on purpose. They are reported or declared,
not estimated (SPEC section 2), so they say nothing about how well the
forecaster did — and they are the parts of a twin most worth keeping private.

Params are strings and metrics are floats, the shapes a tracker expects. A
missing value is recorded as "none" rather than dropped, so every run carries
the same keys and runs line up when compared.

Tracking is off by default and can never break a build (CLAUDE.md, "External
Integrations"): a fresh clone has no tracking server, and a twin that failed to
log is still a correct twin. So `log_twin_build` fails towards not tracking —
only an explicit "yes" turns it on, and any error is logged and swallowed.
"""

import logging
import os
from collections.abc import Callable
from datetime import date

from backend.schemas import FinancialTwin

logger = logging.getLogger(__name__)

MISSING = "none"

# Runs land here rather than in MLflow's "Default" experiment. Where the
# experiment lives is MLflow's own MLFLOW_TRACKING_URI; unset, it is a local
# mlflow.db in the working directory. Databricks only accepts an absolute
# workspace path such as /Shared/twin-builds, hence MLFLOW_EXPERIMENT_NAME.
DEFAULT_EXPERIMENT_NAME = "twin-builds"

# Only an explicit "yes" turns tracking on; a typo leaves it off.
TRACKING_ON = frozenset({"1", "true", "yes", "on"})

LogRun = Callable[[dict[str, str], dict[str, float]], None]


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


# --- Logging ------------------------------------------------------------------


def track_twin_builds() -> bool:
    """True only when someone has explicitly turned tracking on."""
    return (os.getenv("TRACK_TWIN_BUILDS") or "").strip().lower() in TRACKING_ON


def experiment_name() -> str:
    """MLFLOW_EXPERIMENT_NAME, or the local default when it is unset."""
    return (os.getenv("MLFLOW_EXPERIMENT_NAME") or "").strip() or DEFAULT_EXPERIMENT_NAME


def mlflow_log_run(params: dict[str, str], metrics: dict[str, float]) -> None:
    """Record one twin build as one MLflow run."""
    # Imported here so that nothing pays for MLflow while tracking is off.
    import mlflow

    mlflow.set_experiment(experiment_name())
    with mlflow.start_run(run_name=f"twin-build-{params['user_id']}"):
        mlflow.log_params(params)
        mlflow.log_metrics(metrics)


def log_twin_build(twin: FinancialTwin, log_run: LogRun = mlflow_log_run) -> bool:
    """Record a built twin when tracking is on. True if a run was logged.

    Never raises. Tests pass a fake `log_run`, so they never reach MLflow.
    """
    if not track_twin_builds():
        return False
    try:
        log_run(*twin_build_summary(twin))
    except Exception as e:
        logger.warning("Twin build tracking failed, continuing without it: %s", e)
        return False
    return True
