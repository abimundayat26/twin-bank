"""Template-based explanations built only from computed simulation results."""

from datetime import date

from backend.schemas import (
    ExplanationDriver,
    FinancialTwin,
    OptimizationCandidate,
    ScenarioMetrics,
    SimulationEvent,
)
from backend.simulation.engine import low_balance_threshold
from backend.simulation.monte_carlo import (
    INCOME_CLAMP_SDS,
    SPENDING_BLOCK_DAYS,
    MonteCarloComparison,
)


def money(amount: float) -> str:
    sign = "-" if amount < 0 else ""
    return f"{sign}${abs(amount):,.0f}"


def pct(p: float) -> str:
    """Share of simulated futures, without rounding a rare event to 0% or 100%."""
    if 0 < p < 0.01:
        return "under 1%"
    if 0.99 < p < 1:
        return "over 99%"
    return f"{p:.0%}"


def describe_events(events: list[SimulationEvent]) -> str:
    if len(events) == 1:
        return f"the {money(events[0].amount)} {events[0].description.lower()}"
    return f"these purchases ({money(sum(e.amount for e in events))} total)"


def build_summary(twin: FinancialTwin, events: list[SimulationEvent], mc: MonteCarloComparison) -> str:
    base, cf = mc.baseline, mc.counterfactual
    name = twin.display_name
    sentences = [
        f"Across {mc.n_simulations:,} simulated futures, buying {describe_events(events)} changes "
        f"{name}'s median projected balance on {mc.horizon_end} from {money(base.ending_balance)} "
        f"to {money(cf.ending_balance)} (middle 80% of futures: {money(cf.ending_balance_p10)} "
        f"to {money(cf.ending_balance_p90)})."
    ]

    for base_goal, cf_goal in zip(base.goals, cf.goals):
        sentences.append(
            f"{name} meets the {money(cf_goal.target_amount)} {cf_goal.name.lower()} goal on top of "
            f"the {money(mc.reserve)} emergency reserve in {pct(cf_goal.prob_met)} of futures with "
            f"the purchase, versus {pct(base_goal.prob_met)} without it."
        )

    if base.prob_low_balance or cf.prob_low_balance:
        sentences.append(
            f"Checking falls below the {money(low_balance_threshold(twin))} low-balance line in "
            f"{pct(cf.prob_low_balance)} of futures, versus {pct(base.prob_low_balance)} without it."
        )
    if base.prob_below_reserve or cf.prob_below_reserve:
        sentences.append(
            f"Total savings dip below the {money(mc.reserve)} emergency reserve in "
            f"{pct(cf.prob_below_reserve)} of futures, versus {pct(base.prob_below_reserve)}."
        )
    if base.prob_savings_sweep or cf.prob_savings_sweep:
        sentences.append(
            f"In {pct(cf.prob_savings_sweep)} of futures {name} would have to move money out of "
            f"savings to pay a mandatory bill, versus {pct(base.prob_savings_sweep)} without the "
            "purchase."
        )
    if base.prob_obligations_uncovered or cf.prob_obligations_uncovered:
        sentences.append(
            f"In {pct(cf.prob_obligations_uncovered)} of futures checking and savings together would "
            f"not cover a mandatory bill, versus {pct(base.prob_obligations_uncovered)}."
        )

    expected_base, expected_cf = mc.expected.baseline, mc.expected.counterfactual
    if expected_cf.min_checking < expected_base.min_checking:
        sentences.append(
            f"On the expected-value path, checking bottoms out at {money(expected_cf.min_checking)} "
            f"on {expected_cf.min_checking_date} (baseline: {money(expected_base.min_checking)})."
        )
    return " ".join(sentences)


def build_drivers(
    twin: FinancialTwin, events: list[SimulationEvent], mc: MonteCarloComparison
) -> list[ExplanationDriver]:
    base, cf = mc.baseline, mc.counterfactual
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
                detail=f"In the median future, checking bottoms out at {money(cf.min_checking)}, "
                f"versus {money(base.min_checking)} in the baseline.",
            )
        )

    for base_goal, cf_goal in zip(base.goals, cf.goals):
        change = round(cf_goal.median_available - base_goal.median_available, 2)
        if change != 0:
            drivers.append(
                ExplanationDriver(
                    label=f"{cf_goal.name} goal",
                    impact_amount=change,
                    direction="negative" if change < 0 else "positive",
                    detail=f"In the median future, {money(cf_goal.median_available)} is available for the "
                    f"{money(cf_goal.target_amount)} goal on {cf_goal.deadline} after the reserve, "
                    f"versus {money(base_goal.median_available)}.",
                )
            )

    expected_income = mc.expected.counterfactual.total_income
    if expected_income > 0:
        drivers.append(
            ExplanationDriver(
                label="Expected income",
                impact_amount=expected_income,
                direction="positive",
                detail=f"{money(expected_income)} of expected income through {mc.horizon_end} "
                "rebuilds the balance in both scenarios.",
            )
        )
    return drivers


CATEGORY_LABELS = {
    "bill": "a bill",
    "savings_transfer": "a transfer to savings",
    "debt_repayment": "a debt repayment",
    "optional_spending": "optional spending",
    "not_recurring": "not recurring",
}


def low_balance_assumption(twin: FinancialTwin) -> str:
    threshold = money(low_balance_threshold(twin))
    if any(c.type == "minimum_checking_balance" for c in twin.constraints):
        return f"Low balance means checking below {threshold}, the minimum {twin.display_name} set."
    return f"Low balance means checking below {threshold} (default; {twin.display_name} has not set a minimum)."


def category_assumptions(twin: FinancialTwin) -> list[str]:
    assumptions = []
    for o in twin.obligations:
        if o.declared_category is None:
            continue
        label = CATEGORY_LABELS[o.declared_category]
        if o.declared_category == "not_recurring":
            effect = "so it is left out of the projection"
        elif o.declared_category == "savings_transfer":
            effect = "so it moves from checking to savings and total savings are unchanged"
        elif o.declared_category == "optional_spending":
            effect = "so it is charged but does not count as a mandatory bill"
        else:
            effect = "so it counts as a mandatory bill"
        assumptions.append(f"{twin.display_name} declared {o.name} as {label}, {effect}.")
    if any(o.declared_category is None for o in twin.obligations):
        assumptions.append(
            "Every other recurring bill, including optional ones, is charged in full."
            if assumptions
            else "Every recurring bill, including optional ones, is charged in full."
        )
    return assumptions


def build_assumptions(twin: FinancialTwin, mc: MonteCarloComparison) -> list[str]:
    assumptions = [
        f"Monte Carlo over {mc.n_simulations:,} simulated futures. In each future, the baseline and the "
        "purchase scenario share the same sampled income and spending.",
        "Balances are medians across simulated futures. Probabilities are the share of futures "
        "in which the event happens.",
        "Each paycheck is drawn independently from a normal distribution around its expected amount, "
        f"using the twin's per-payment uncertainty, kept within {INCOME_CLAMP_SDS:g} standard "
        "deviations and never below $0.",
        f"Spending in each category is drawn independently for every {SPENDING_BLOCK_DAYS}-day period "
        "from a normal distribution using the twin's mean and standard deviation, spread evenly over "
        "the period and never below $0 (which raises average spending slightly).",
        "Bill amounts, bill due dates, and paycheck dates are fixed; bill confidence is not used.",
        "A mandatory bill checking cannot cover is paid by moving money from savings, even if "
        "that breaks the emergency reserve; it counts as uncovered only when checking and savings "
        "together fall short.",
        "Everyday spending and optional charges are never paid from savings.",
        low_balance_assumption(twin),
        "The emergency reserve counts checking plus savings.",
        "Goals must be met on top of the emergency reserve.",
        "Income, bills, and everyday spending all flow through checking.",
        *category_assumptions(twin),
        f"The horizon runs from {twin.as_of} to {mc.horizon_end}.",
    ]
    if any(g.deadline > mc.horizon_end for g in twin.goals):
        assumptions.append("Goals with deadlines after the horizon are not evaluated.")
    return assumptions


# --- Optimization -------------------------------------------------------------


def goal_chance(metrics: ScenarioMetrics) -> str:
    return pct(metrics.prob_goal_met) if metrics.prob_goal_met is not None else "n/a"


def build_optimization_summary(
    twin: FinancialTwin,
    baseline: ScenarioMetrics,
    buy_now: OptimizationCandidate,
    recommended: OptimizationCandidate | None,
    candidates: list[OptimizationCandidate],
    baseline_violations: list[str],
) -> str:
    """baseline_violations: declared limits already broken without the purchase."""
    name = twin.display_name
    has_goal = buy_now.metrics.prob_goal_met is not None
    if has_goal:
        sentences = [
            f"Buying now, {name} meets every goal in the horizon in {goal_chance(buy_now.metrics)} "
            f"of futures, versus {goal_chance(baseline)} without the purchase."
        ]
    else:
        sentences = [
            f"Buying now, {name}'s median ending balance is {money(buy_now.metrics.ending_balance)}, "
            f"versus {money(baseline.ending_balance)} without the purchase."
        ]

    if baseline_violations:
        sentences.append(
            f"Even without the purchase, a declared limit is already broken: {baseline_violations[0]} "
            "Options are only faulted for making that worse."
        )

    if recommended is None:
        closest = candidates[0]
        sentences.append(
            f"None of the {len(candidates)} options keeps every limit {name} declared. "
            f"The closest is \"{closest.label}\": {closest.violations[0]}"
        )
    elif recommended.kind == "buy_now":
        sentences.append(
            f"Buying now keeps every limit {name} declared, and none of the other "
            f"{len(candidates) - 1} options scores better on the goal or on risk."
        )
    else:
        m = recommended.metrics
        outcome = (
            f"meets the goal in {goal_chance(m)} of futures"
            if has_goal
            else f"ends with a median {money(m.ending_balance)}"
        )
        sentences.append(
            f"The best-scoring option that keeps every limit {name} declared is "
            f"\"{recommended.label}\": it {outcome}, and checking plus savings dips below the "
            f"reserve in {pct(m.prob_below_reserve)} of futures (buying now: "
            f"{pct(buy_now.metrics.prob_below_reserve)})."
        )

    breaking = sum(not c.meets_constraints for c in candidates)
    if breaking and recommended is not None:
        sentences.append(f"{breaking} of the {len(candidates)} options break a declared limit.")
    return " ".join(sentences)


def build_optimization_assumptions(
    twin: FinancialTwin,
    horizon_end: date,
    n_simulations: int,
    max_constraint_risk: float,
    max_delay_paydays: int,
) -> list[str]:
    name = twin.display_name
    declared_floor = any(c.type == "minimum_checking_balance" for c in twin.constraints)
    return [
        f"Every option is scored on the same {n_simulations:,} simulated futures, so differences "
        "between options come from the action, not from luck.",
        f"A declared limit counts as kept if it is broken in at most {pct(max_constraint_risk)} of "
        f"futures. This is a team default; {name} did not set it.",
        "An option breaks a limit if any future leaves a mandatory bill unpaid, even after moving "
        "money from savings.",
        f"The {money(low_balance_threshold(twin))} minimum checking balance {name} set is a hard limit."
        if declared_floor
        else f"The low-balance line is not a hard limit, because {name} has not set one.",
        "The emergency reserve counts checking plus savings.",
        "Goals must be met on top of the emergency reserve.",
        f"Delays move the purchase to the day after one of the next {max_delay_paydays} paydays, "
        "within the horizon.",
        f"Spending cuts scale that category's average and spread for the whole horizon, "
        f"{twin.as_of} to {horizon_end}.",
        "Options are ranked by the chance of meeting every goal, then risk to the reserve and to "
        "bills, then by how little they change the plan.",
    ]
