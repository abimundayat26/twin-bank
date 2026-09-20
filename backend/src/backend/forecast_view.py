"""Baseline balance bands and deterministic callouts for Forecast & Data.

This is a view over the existing simulator, not a second forecast engine.  It
runs the baseline with no hypothetical event, then names only extrema and
causes supported by facts already present on the twin (FD-6 to FD-9).
"""

from dataclasses import dataclass
from datetime import date, timedelta

from backend.schemas import FinancialTwin, ForecastCallout, ForecastPayload
from backend.simulation import to_scenario_bands
from backend.simulation.engine import income_dates, monthly_due_dates
from backend.simulation.monte_carlo import DEFAULT_SIMULATIONS, run_monte_carlo

SMOOTHING_DAYS = 7
MIN_PROMINENCE = 100.0
MIN_CALLOUT_GAP_DAYS = 21
MAX_PER_KIND = 2
REASON_WINDOW_DAYS = 14


@dataclass(frozen=True)
class _Extremum:
    index: int
    kind: str
    prominence: float


def _moving_mean(values: list[float], width: int = SMOOTHING_DAYS) -> list[float]:
    """Centered moving mean, using the available points at either edge."""
    radius = width // 2
    return [
        sum(values[max(0, i - radius) : min(len(values), i + radius + 1)])
        / len(values[max(0, i - radius) : min(len(values), i + radius + 1)])
        for i in range(len(values))
    ]


def _prominence(values: list[float], index: int, kind: str) -> float:
    """Topographic prominence of one local high or low point."""
    value = values[index]
    left = index - 1
    while left > 0 and (
        values[left] <= value if kind == "peak" else values[left] >= value
    ):
        left -= 1
    right = index + 1
    while right < len(values) - 1 and (
        values[right] <= value if kind == "peak" else values[right] >= value
    ):
        right += 1

    if kind == "peak":
        return min(
            value - min(values[left : index + 1]),
            value - min(values[index : right + 1]),
        )
    return min(
        max(values[left : index + 1]) - value,
        max(values[index : right + 1]) - value,
    )


def select_extrema(values: list[float], dates: list[date]) -> list[_Extremum]:
    """Pick at most two separated peaks and troughs from a seven-day mean."""
    if len(values) < 3 or len(values) != len(dates):
        return []
    smooth = _moving_mean(values)
    candidates: list[_Extremum] = []
    for index in range(1, len(smooth) - 1):
        before, value, after = smooth[index - 1 : index + 2]
        kind = None
        if (value > before and value >= after) or (value >= before and value > after):
            kind = "peak"
        elif (value < before and value <= after) or (value <= before and value < after):
            kind = "trough"
        if kind is None:
            continue
        prominence = _prominence(smooth, index, kind)
        if prominence >= MIN_PROMINENCE:
            candidates.append(_Extremum(index, kind, prominence))

    chosen: list[_Extremum] = []
    counts = {"peak": 0, "trough": 0}
    for candidate in sorted(candidates, key=lambda item: (-item.prominence, dates[item.index])):
        if counts[candidate.kind] >= MAX_PER_KIND:
            continue
        if any(
            abs((dates[candidate.index] - dates[kept.index]).days) < MIN_CALLOUT_GAP_DAYS
            for kept in chosen
        ):
            continue
        chosen.append(candidate)
        counts[candidate.kind] += 1
    return sorted(chosen, key=lambda item: dates[item.index])


def _short_date(value: date, as_of: date) -> str:
    label = f"{value.strftime('%b')} {value.day}"
    return f"{label}, {value.year}" if value.year != as_of.year else label


def _reason(twin: FinancialTwin, point: date, prominence: float) -> str | None:
    window_start = point - timedelta(days=REASON_WINDOW_DAYS)

    one_time = sorted(
        (
            item
            for item in twin.one_time_obligations
            if window_start <= item.due_date <= point
        ),
        key=lambda item: (item.due_date, item.amount, item.name),
        reverse=True,
    )
    if one_time:
        return f"{one_time[0].name} due"

    recurring: list[tuple[date, float, str]] = []
    for item in twin.obligations:
        if not item.active or item.declared_category == "not_recurring":
            continue
        for due in monthly_due_dates(item.due_day, window_start - timedelta(days=1), point):
            if item.expected_amount >= prominence * 0.25:
                recurring.append((due, item.expected_amount, item.name))
    if recurring:
        _, _, name = max(recurring)
        return f"{name} due"

    seasonal = [
        (category.seasonal.factors[point.month], category.category)
        for category in twin.variable_spending
        if category.seasonal is not None
    ]
    if seasonal:
        _, category = max(seasonal)
        return f"heavy {category} spending"

    for stream in twin.income:
        if income_dates(stream.next_date, stream.interval_days, window_start - timedelta(days=1), point):
            return "paycheck"
    return None


def build_callouts(twin: FinancialTwin, dates: list[date], medians: list[float]) -> list[ForecastCallout]:
    callouts = []
    for extremum in select_extrema(medians, dates):
        at = dates[extremum.index]
        kind_label = "High" if extremum.kind == "peak" else "Low"
        reason = _reason(twin, at, extremum.prominence)
        label = f"{_short_date(at, twin.as_of)} · {kind_label}"
        if reason:
            label += f": {reason}"
        callouts.append(
            ForecastCallout(
                date=at,
                kind=extremum.kind,
                balance=medians[extremum.index],
                label=label,
            )
        )
    return callouts


def build_forecast(
    twin: FinancialTwin,
    *,
    n_simulations: int = DEFAULT_SIMULATIONS,
    seed: int | None = None,
    is_mock: bool = False,
) -> ForecastPayload:
    """Run and serialize the no-purchase baseline without changing /simulate."""
    result = run_monte_carlo(
        twin,
        [],
        n_simulations=n_simulations,
        seed=seed,
        bands=True,
    )
    assert result.baseline_bands is not None
    bands = to_scenario_bands(result.baseline_bands)
    return ForecastPayload(
        user_id=twin.user_id,
        horizon_end=result.horizon_end,
        bands=bands,
        callouts=build_callouts(
            twin,
            [point.date for point in bands.total],
            [point.median for point in bands.total],
        ),
        num_simulations=result.n_simulations,
        is_mock=is_mock,
    )
