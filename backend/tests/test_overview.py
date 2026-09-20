"""Deterministic Overview figures and the thin GET route (OV-1 to OV-8)."""

from datetime import date

import pytest
from fastapi.testclient import TestClient

from backend.fixtures import load_twin
from backend.main import app
from backend.overview import AVERAGE_DAYS_PER_MONTH, build_overview
from backend.schemas import (
    FinancialObligation,
    Goal,
    IncomeStream,
    OneTimeObligation,
    OverviewPayload,
    VariableSpendingDistribution,
)
from backend.simulation.engine import simulate_scenario

client = TestClient(app)


def recurring(
    obligation_id: str,
    name: str,
    amount: float,
    due_day: int,
    *,
    active: bool = True,
    declared_category: str | None = None,
) -> FinancialObligation:
    return FinancialObligation(
        id=obligation_id,
        name=name,
        expected_amount=amount,
        due_day=due_day,
        mandatory=True,
        confidence=1,
        active=active,
        declared_category=declared_category,
    )


def empty_twin(**updates):
    values = {
        "accounts": [],
        "income": [],
        "obligations": [],
        "variable_spending": [],
        "goals": [],
        "constraints": [],
        "one_time_obligations": [],
    }
    values.update(updates)
    return load_twin().model_copy(update=values)


def test_balances_cash_flow_goal_progress_and_accounts():
    twin = load_twin().model_copy(
        update={
            "goals": [
                Goal(
                    id="goal_one",
                    name="One",
                    target_amount=100,
                    current_amount=40,
                    deadline=date(2027, 1, 1),
                ),
                Goal(
                    id="goal_two",
                    name="Two",
                    target_amount=200,
                    current_amount=250,
                    deadline=date(2027, 2, 1),
                ),
            ]
        }
    )

    overview = build_overview(twin)

    monthly_income = 725.21 * AVERAGE_DAYS_PER_MONTH / 14
    fixed_bills = sum(obligation.expected_amount for obligation in twin.obligations)
    assert overview.total_balance == 3140
    assert overview.monthly_net_cash_flow == round(monthly_income - fixed_bills, 2)
    assert overview.goal_progress == pytest.approx(240 / 300)
    assert [account.model_dump() for account in overview.accounts] == [
        {"id": "acc_checking", "name": "Everyday Checking", "balance": 1340.0},
        {"id": "acc_savings", "name": "Savings", "balance": 1800.0},
    ]


def test_paused_and_not_recurring_payments_are_excluded_everywhere():
    twin = empty_twin(
        accounts=load_twin().accounts,
        income=[
            IncomeStream(
                id="income",
                source="Pay",
                expected_amount=1200,
                interval_days=30,
                next_date=date(2026, 9, 20),
                uncertainty=0,
            )
        ],
        obligations=[
            recurring("bill", "Bill", 100, 20),
            recurring("paused", "Paused", 200, 21, active=False),
            recurring(
                "not_recurring",
                "Not recurring",
                300,
                22,
                declared_category="not_recurring",
            ),
        ],
    )

    overview = build_overview(twin)

    assert overview.monthly_net_cash_flow == round(1200 * AVERAGE_DAYS_PER_MONTH / 30 - 100, 2)
    assert next(item for item in overview.spending if item.label == "Fixed bills").monthly_amount == 100
    assert [item.name for item in overview.upcoming if item.kind == "recurring_bill"] == ["Bill"]


def test_savings_transfer_moves_money_but_is_not_external_spending():
    transfer = recurring(
        "transfer",
        "Savings transfer",
        250,
        19,
        declared_category="savings_transfer",
    )
    twin = empty_twin(accounts=load_twin().accounts, obligations=[transfer])

    overview = build_overview(twin)
    projected = simulate_scenario(twin, [], date(2026, 9, 19))

    assert overview.monthly_net_cash_flow == 0
    assert overview.total_monthly_spending == 0
    assert overview.upcoming == []
    assert projected.checking[-1] == 1090
    assert projected.total[-1] == 3140


def test_no_goals_returns_none_and_no_accounts_is_a_valid_payload():
    overview = build_overview(empty_twin())

    assert OverviewPayload.model_validate(overview.model_dump()) == overview
    assert overview.total_balance == 0
    assert overview.goal_progress is None
    assert overview.accounts == []


def test_spending_keeps_top_four_and_groups_the_rest():
    def spending(label: str, monthly_amount: float) -> VariableSpendingDistribution:
        return VariableSpendingDistribution(
            category=label,
            mean_14d=monthly_amount * 14 / AVERAGE_DAYS_PER_MONTH,
            std_dev_14d=0,
        )

    twin = empty_twin(
        accounts=load_twin().accounts,
        obligations=[recurring("fixed", "Fixed", 50, 15)],
        variable_spending=[
            spending("A", 100),
            spending("B", 90),
            spending("C", 80),
            spending("D", 70),
            spending("E", 60),
        ],
    )

    overview = build_overview(twin)

    assert [(item.label, item.monthly_amount) for item in overview.spending] == [
        ("A", 100),
        ("B", 90),
        ("C", 80),
        ("D", 70),
        ("Other", 110),
    ]
    assert overview.total_monthly_spending == 450


def test_upcoming_window_is_inclusive_and_due_day_is_clamped():
    as_of = date(2026, 4, 1)
    twin = empty_twin(
        accounts=load_twin().accounts,
        as_of=as_of,
        obligations=[recurring("month_end", "Month end", 31, 31)],
        one_time_obligations=[
            OneTimeObligation(
                id="today",
                name="Today",
                amount=10,
                due_date=as_of,
                account_id="acc_checking",
                mandatory=True,
            ),
            OneTimeObligation(
                id="day_30",
                name="Day 30",
                amount=20,
                due_date=date(2026, 5, 1),
                account_id="acc_checking",
                mandatory=True,
            ),
            OneTimeObligation(
                id="day_31",
                name="Day 31",
                amount=30,
                due_date=date(2026, 5, 2),
                account_id="acc_checking",
                mandatory=True,
            ),
        ],
    )

    overview = build_overview(twin)

    assert [(item.name, item.date) for item in overview.upcoming] == [
        ("Today", date(2026, 4, 1)),
        ("Month end", date(2026, 4, 30)),
        ("Day 30", date(2026, 5, 1)),
    ]


def test_upcoming_is_sorted_then_truncated_to_five():
    as_of = date(2026, 9, 18)
    twin = empty_twin(
        accounts=load_twin().accounts,
        as_of=as_of,
        income=[
            IncomeStream(
                id="late",
                source="Late pay",
                expected_amount=200,
                interval_days=30,
                next_date=date(2026, 10, 10),
                uncertainty=0,
            ),
            IncomeStream(
                id="cadence",
                source="Pay",
                expected_amount=100,
                interval_days=5,
                next_date=as_of,
                uncertainty=0,
            ),
        ],
        one_time_obligations=[
            OneTimeObligation(
                id="same_day",
                name="A bill",
                amount=10,
                due_date=as_of,
                account_id="acc_checking",
                mandatory=True,
            )
        ],
    )

    overview = build_overview(twin)

    assert len(overview.upcoming) == 5
    assert [(item.name, item.date) for item in overview.upcoming] == [
        ("A bill", as_of),
        ("Pay", as_of),
        ("Pay", date(2026, 9, 23)),
        ("Pay", date(2026, 9, 28)),
        ("Pay", date(2026, 10, 3)),
    ]


def test_overview_route_uses_the_existing_twin_and_contract():
    response = client.get("/twin/alex/overview")

    assert response.status_code == 200
    assert OverviewPayload.model_validate(response.json()) == build_overview(
        load_twin().model_copy(update={"source": "fixture"})
    )


def test_overview_route_unknown_user_keeps_exact_404():
    response = client.get("/twin/nobody/overview")

    assert response.status_code == 404
    assert response.json() == {"detail": "No twin for user 'nobody'"}
