"""Template-based explanations built only from computed simulation results."""

from backend.schemas import ExplanationDriver, FinancialTwin, SimulationEvent
from backend.simulation.engine import LOW_BALANCE_THRESHOLD, Comparison


def money(amount: float) -> str:
    sign = "-" if amount < 0 else ""
    return f"{sign}${abs(amount):,.0f}"


def describe_events(events: list[SimulationEvent]) -> str:
    if len(events) == 1:
        return f"the {money(events[0].amount)} {events[0].description.lower()}"
    return f"these purchases ({money(sum(e.amount for e in events))} total)"


def build_summary(twin: FinancialTwin, events: list[SimulationEvent], comparison: Comparison) -> str:
    base, cf = comparison.baseline, comparison.counterfactual
    name = twin.display_name
    sentences = [
        f"Buying {describe_events(events)} changes {name}'s projected balance on "
        f"{comparison.horizon_end} from {money(base.ending_balance)} to {money(cf.ending_balance)}."
    ]

    for base_goal, cf_goal in zip(base.goals, cf.goals):
        goal = f"the {money(cf_goal.target_amount)} {cf_goal.name.lower()} goal"
        if cf_goal.shortfall > 0 and base_goal.shortfall == 0:
            sentences.append(
                f"After keeping the {money(comparison.reserve)} emergency reserve, {name} would be "
                f"{money(cf_goal.shortfall)} short of {goal}, which the baseline meets with "
                f"{money(base_goal.surplus)} to spare."
            )
        elif cf_goal.shortfall > 0:
            sentences.append(
                f"The shortfall on {goal} grows from {money(base_goal.shortfall)} "
                f"to {money(cf_goal.shortfall)}."
            )
        else:
            sentences.append(
                f"{name} still meets {goal} on top of the reserve, but the cushion shrinks from "
                f"{money(base_goal.surplus)} to {money(cf_goal.surplus)}."
            )

    if cf.dropped_below_low and not base.dropped_below_low:
        sentences.append(
            f"Checking dips to {money(cf.min_checking)} on {cf.min_checking_date}, below the "
            f"{money(LOW_BALANCE_THRESHOLD)} low-balance line (baseline low: {money(base.min_checking)})."
        )
    if cf.reserve_violated and not base.reserve_violated:
        sentences.append(
            f"Total savings fall below the {money(comparison.reserve)} emergency reserve, "
            f"reaching {money(cf.min_balance)}."
        )
    if not cf.obligations_covered:
        first = cf.uncovered_obligations[0]
        sentences.append(
            f"Checking would not cover {first.name.lower()} due {first.due} "
            f"without moving money from savings."
        )
    return " ".join(sentences)


def build_drivers(
    twin: FinancialTwin, events: list[SimulationEvent], comparison: Comparison
) -> list[ExplanationDriver]:
    base, cf = comparison.baseline, comparison.counterfactual
    account_names = {a.id: a.name for a in twin.accounts}
    drivers = [
        ExplanationDriver(
            label=event.description,
            impact_amount=-event.amount,
            direction="negative",
            detail=f"One-time {money(event.amount)} from {account_names[event.account_id]} on {event.date}.",
        )
        for event in events
    ]

    checking_change = round(cf.min_checking - base.min_checking, 2)
    if checking_change != 0:
        drivers.append(
            ExplanationDriver(
                label="Lowest checking balance",
                impact_amount=checking_change,
                direction="negative" if checking_change < 0 else "positive",
                detail=f"Checking bottoms out at {money(cf.min_checking)} on {cf.min_checking_date}, "
                f"versus {money(base.min_checking)} in the baseline.",
            )
        )

    for base_goal, cf_goal in zip(base.goals, cf.goals):
        change = round(cf_goal.available - base_goal.available, 2)
        if change != 0:
            drivers.append(
                ExplanationDriver(
                    label=f"{cf_goal.name} goal",
                    impact_amount=change,
                    direction="negative" if change < 0 else "positive",
                    detail=f"{money(cf_goal.available)} available for the {money(cf_goal.target_amount)} "
                    f"goal on {cf_goal.deadline} after the reserve, versus {money(base_goal.available)}.",
                )
            )

    if cf.total_income > 0:
        drivers.append(
            ExplanationDriver(
                label="Expected income",
                impact_amount=cf.total_income,
                direction="positive",
                detail=f"{money(cf.total_income)} of expected income through {comparison.horizon_end} "
                "rebuilds the balance in both scenarios.",
            )
        )
    return drivers


def build_assumptions(twin: FinancialTwin, comparison: Comparison) -> list[str]:
    assumptions = [
        "Deterministic projection using expected values; income and spending variability are not yet modeled.",
        "Probabilities are 0 or 1 because the projection is deterministic.",
        f"Low balance means checking below {money(LOW_BALANCE_THRESHOLD)}.",
        "The emergency reserve counts checking plus savings.",
        "Goals must be met on top of the emergency reserve.",
        "Income, bills, and everyday spending all flow through checking.",
        "Every recurring bill, including optional ones, is charged in full.",
        f"The horizon runs from {twin.as_of} to {comparison.horizon_end}.",
    ]
    if any(g.deadline > comparison.horizon_end for g in twin.goals):
        assumptions.append("Goals with deadlines after the horizon are not evaluated.")
    return assumptions
