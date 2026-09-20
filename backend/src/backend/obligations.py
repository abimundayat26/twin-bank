"""Pure construction of the read-only Obligations API payload."""

from backend.schemas import (
    CategoryOption,
    FinancialTwin,
    ObligationCategory,
    ObligationsPayload,
    OneTimeObligationRow,
    RecurringObligationRow,
)

CATEGORY_LABELS: dict[ObligationCategory, str] = {
    "bill": "Bill",
    "savings_transfer": "Savings transfer",
    "debt_repayment": "Debt repayment",
    "optional_spending": "Optional spending",
    "not_recurring": "Not recurring",
}


def build_obligations(twin: FinancialTwin) -> ObligationsPayload:
    """Turn a Financial Twin into its deterministic management listing."""
    recurring = [
        RecurringObligationRow(
            id=obligation.id,
            name=obligation.name,
            amount=obligation.expected_amount,
            due_day=obligation.due_day,
            active=obligation.active,
            origin="detected" if obligation.provenance == "observed" else "declared",
            category_label=(
                CATEGORY_LABELS[obligation.declared_category]
                if obligation.declared_category is not None
                else None
            ),
            needs_answer=(
                bool(obligation.category_candidates)
                and obligation.declared_category is None
            ),
            options=[
                CategoryOption(
                    category=candidate.category,
                    label=CATEGORY_LABELS[candidate.category],
                )
                for candidate in obligation.category_candidates
            ],
        )
        for obligation in twin.obligations
    ]
    recurring.sort(key=lambda row: (row.due_day, row.name.casefold(), row.name, row.id))

    account_names = {account.id: account.name for account in twin.accounts}
    one_time = [
        OneTimeObligationRow(
            id=obligation.id,
            name=obligation.name,
            amount=obligation.amount,
            due_date=obligation.due_date,
            account_id=obligation.account_id,
            account_name=account_names.get(obligation.account_id, obligation.account_id),
            mandatory=obligation.mandatory,
        )
        for obligation in twin.one_time_obligations
        if obligation.due_date > twin.as_of
    ]
    one_time.sort(key=lambda row: (row.due_date, row.name.casefold(), row.name, row.id))

    return ObligationsPayload(
        user_id=twin.user_id,
        as_of=twin.as_of,
        recurring=recurring,
        one_time=one_time,
    )
