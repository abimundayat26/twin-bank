"""Pure, deterministic construction of the Overview API payload."""

from datetime import timedelta

from backend.schemas import (
    FinancialObligation,
    FinancialTwin,
    OverviewAccount,
    OverviewPayload,
    SpendingSlice,
    UpcomingItem,
)
from backend.simulation.engine import income_dates, is_charged, monthly_due_dates

AVERAGE_DAYS_PER_MONTH = 365 / 12
UPCOMING_WINDOW_DAYS = 30


def _external_fixed_obligations(twin: FinancialTwin) -> list[FinancialObligation]:
    """Recurring charges that leave the twin rather than move money within it.

    `is_charged` is the engine's authoritative active/not-recurring filter. A
    savings transfer passes that filter because the engine moves it from checking
    into savings, but it is not a bill and must not reduce total cash flow (OV-3).
    """
    return [
        obligation
        for obligation in twin.obligations
        if is_charged(obligation) and obligation.declared_category != "savings_transfer"
    ]


def _monthly_income(twin: FinancialTwin) -> float:
    return sum(
        stream.expected_amount * AVERAGE_DAYS_PER_MONTH / stream.interval_days
        for stream in twin.income
    )


def _goal_progress(twin: FinancialTwin) -> float | None:
    if not twin.goals:
        return None
    target = sum(goal.target_amount for goal in twin.goals)
    saved = sum(min(goal.current_amount, goal.target_amount) for goal in twin.goals)
    return saved / target


def _spending_slices(
    twin: FinancialTwin, fixed_obligations: list[FinancialObligation]
) -> tuple[list[SpendingSlice], float]:
    slices = [
        SpendingSlice(
            label=spending.category,
            monthly_amount=round(
                spending.mean_14d * AVERAGE_DAYS_PER_MONTH / 14,
                2,
            ),
        )
        for spending in twin.variable_spending
    ]
    slices.append(
        SpendingSlice(
            label="Fixed bills",
            monthly_amount=round(
                sum(obligation.expected_amount for obligation in fixed_obligations),
                2,
            ),
        )
    )
    slices.sort(key=lambda item: (-item.monthly_amount, item.label.casefold()))
    total = round(sum(item.monthly_amount for item in slices), 2)
    if len(slices) <= 4:
        return slices, total
    other = round(sum(item.monthly_amount for item in slices[4:]), 2)
    return [*slices[:4], SpendingSlice(label="Other", monthly_amount=other)], total


def _upcoming_items(
    twin: FinancialTwin, fixed_obligations: list[FinancialObligation]
) -> list[UpcomingItem]:
    window_end = twin.as_of + timedelta(days=UPCOMING_WINDOW_DAYS)
    # Engine helpers use an exclusive start. Moving it back one day implements
    # Overview's inclusive [as_of, as_of + 30 days] window without duplicating
    # cadence or due-day clamping logic.
    expansion_start = twin.as_of - timedelta(days=1)
    items: list[UpcomingItem] = []

    for stream in twin.income:
        for payment_date in income_dates(
            stream.next_date,
            stream.interval_days,
            expansion_start,
            window_end,
        ):
            items.append(
                UpcomingItem(
                    name=stream.source,
                    amount=round(stream.expected_amount, 2),
                    date=payment_date,
                    kind="income",
                )
            )

    for obligation in fixed_obligations:
        due_dates = monthly_due_dates(
            obligation.due_day,
            expansion_start,
            window_end,
        )
        if due_dates:
            items.append(
                UpcomingItem(
                    name=obligation.name,
                    amount=round(-obligation.expected_amount, 2),
                    date=due_dates[0],
                    kind="recurring_bill",
                )
            )

    for obligation in twin.one_time_obligations:
        if twin.as_of <= obligation.due_date <= window_end:
            items.append(
                UpcomingItem(
                    name=obligation.name,
                    amount=round(-obligation.amount, 2),
                    date=obligation.due_date,
                    kind="one_time_bill",
                )
            )

    items.sort(key=lambda item: (item.date, item.name.casefold(), item.kind))
    return items[:5]


def build_overview(twin: FinancialTwin) -> OverviewPayload:
    """Turn a Financial Twin into the backend-owned Overview figures (OV-2 to OV-8)."""
    fixed_obligations = _external_fixed_obligations(twin)
    fixed_bills = sum(obligation.expected_amount for obligation in fixed_obligations)
    spending, total_monthly_spending = _spending_slices(twin, fixed_obligations)

    return OverviewPayload(
        user_id=twin.user_id,
        as_of=twin.as_of,
        total_balance=twin.total_balance,
        monthly_net_cash_flow=round(_monthly_income(twin) - fixed_bills, 2),
        goal_progress=_goal_progress(twin),
        accounts=[
            OverviewAccount(id=account.id, name=account.name, balance=account.balance)
            for account in twin.accounts
        ],
        spending=spending,
        total_monthly_spending=total_monthly_spending,
        upcoming=_upcoming_items(twin, fixed_obligations),
    )
