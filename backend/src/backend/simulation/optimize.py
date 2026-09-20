"""Basic optimization: score a few alternatives to buying now, on shared simulated futures.

Deterministic search over a small, fixed set of actions (SPEC section 7). Every
action is run through the same Monte Carlo with the same seed, so all of them
face the same sampled paychecks and spending, and the action is the only
difference. Hard constraints are checked in code against the user's declared
constraints. Nothing here decides whether the user "can afford" anything: every
option comes back with its numbers, and the user picks.

Candidate actions:
- buy_now: the purchase as requested (the reference point).
- delay: the same purchase the day after one of the next few paydays.
- reduce_spending: buy now, and scale a spending category down for the whole horizon.
- from_savings: buy now, paying from savings instead of checking.
- delay and reduce_spending together: only tried when no single action above keeps
  every declared limit.
"""

import random
from dataclasses import dataclass
from datetime import date, timedelta
from uuid import uuid4

from backend.schemas import (
    CandidateKind,
    FinancialTwin,
    OptimizationCandidate,
    OptimizationRequest,
    OptimizationResponse,
    ScenarioMetrics,
    SimulationEvent,
    SpendingAdjustment,
    VariableSpendingDistribution,
)
from backend.simulation import to_metrics
from backend.simulation.engine import (
    SPENDING_BLOCK_DAYS,
    declared_commitments,
    expected_daily_spending,
    income_dates,
    low_balance_threshold,
    reserve_amount,
    resolve_horizon_end,
    savings_account_id,
    validate_events,
)
from backend.simulation.explain import (
    build_optimization_assumptions,
    build_optimization_summary,
    money,
    pct,
)
from backend.simulation.monte_carlo import run_monte_carlo

# Fewer runs than /simulate: every candidate costs one Monte Carlo, and shared
# random numbers keep the comparison between candidates steady at this size.
DEFAULT_OPTIMIZE_SIMULATIONS = 300
MAX_DELAY_PAYDAYS = 4
SPENDING_CUT_CATEGORY = "discretionary"
SPENDING_CUT_MULTIPLIERS = (0.75, 0.5)
# Assumption (team default, not declared by the user): a declared limit counts as
# kept if it is broken in at most this share of simulated futures.
MAX_CONSTRAINT_RISK = 0.05
COMBINED_ASSUMPTION = (
    "No single option kept every limit, so each delay was also tried together with each "
    "spending cut."
)

# Least to most disruptive, for breaking ties between equally good outcomes.
KIND_ORDER: dict[CandidateKind, int] = {"buy_now": 0, "from_savings": 1, "delay": 2, "reduce_spending": 3}


@dataclass(frozen=True)
class Candidate:
    id: str
    kind: CandidateKind
    label: str
    detail: str
    events: list[SimulationEvent]
    spending_adjustments: list[SpendingAdjustment]
    disruption: float  # days delayed, or share of spending cut


def commitments_assumption(twin: FinancialTwin, horizon_end: date) -> list[str]:
    """Say that alternatives were weighed against what the user already owes.

    Every candidate moves the purchase or trims discretionary spending; none of them
    touches a declared obligation. A commitment the user has already made is not
    TwinBank's to reschedule, and the spec sets no criterion that would make
    "delay the tuition" a legal option, so it is not generated. Saying so is the
    difference between the numbers quietly changing and the user knowing why.
    """
    owed = declared_commitments(twin, horizon_end)
    if not owed:
        return []
    total = money(sum(o.amount for o in owed))
    noun = "commitment" if len(owed) == 1 else "commitments"
    line = (
        f"Every option is weighed against {total} of one-time {noun} you have already "
        f"declared between {twin.as_of} and {horizon_end}"
    )
    if any(o.mandatory for o in owed):
        line += ", and no option moves or cancels one you marked mandatory"
    return [f"{line}."]


def describe_purchase(events: list[SimulationEvent]) -> str:
    if len(events) == 1:
        return f"the {events[0].description.lower()}"
    return "these purchases"


def buy_now_candidate(twin: FinancialTwin, events: list[SimulationEvent]) -> Candidate:
    accounts = {a.id: a.name for a in twin.accounts}
    where = " and ".join(sorted({accounts[e.account_id] for e in events}))
    first = min(e.date for e in events)
    return Candidate(
        id="cand_buy_now",
        kind="buy_now",
        label="Buy now",
        detail=f"Buy {describe_purchase(events)} on {first} from {where}, as planned.",
        events=events,
        spending_adjustments=[],
        disruption=0,
    )


def delay_candidates(
    twin: FinancialTwin, events: list[SimulationEvent], horizon_end: date
) -> list[Candidate]:
    """Move every event by the same number of days, to the day after an upcoming payday.

    Paychecks land at the end of their day, so the day after is the first day the
    money is there. A delay that would push any event past the horizon is skipped.
    """
    first = min(e.date for e in events)
    last = max(e.date for e in events)
    paydays = sorted(
        {
            d
            for stream in twin.income
            for d in income_dates(stream.next_date, stream.interval_days, first, horizon_end)
        }
    )
    candidates = []
    for payday in paydays[:MAX_DELAY_PAYDAYS]:
        shift = (payday + timedelta(days=1) - first).days
        if last + timedelta(days=shift) > horizon_end:
            break
        new_date = first + timedelta(days=shift)
        candidates.append(
            Candidate(
                id=f"cand_delay_{new_date}",
                kind="delay",
                label=f"Wait until {new_date}",
                detail=f"Buy {describe_purchase(events)} on {new_date}, {shift} days later, "
                f"the day after the {payday} paycheck lands.",
                events=[
                    e.model_copy(update={"date": e.date + timedelta(days=shift)}) for e in events
                ],
                spending_adjustments=[],
                disruption=shift,
            )
        )
    return candidates


def horizon_mean_14d(
    twin: FinancialTwin, category: VariableSpendingDistribution, horizon_end: date
) -> float:
    """What the simulation expects this category to spend per 14 days through horizon_end.

    A seasonal category's mean_14d is its annual average; over a short horizon the
    months it actually covers can be busier or quieter than that.
    """
    if category.seasonal is None:
        return category.mean_14d
    only_category = twin.model_copy(update={"variable_spending": [category]})
    daily = expected_daily_spending(only_category, horizon_end)
    return sum(daily.values()) / len(daily) * SPENDING_BLOCK_DAYS


def reduce_spending_candidates(
    twin: FinancialTwin, events: list[SimulationEvent], horizon_end: date
) -> list[Candidate]:
    category = next((v for v in twin.variable_spending if v.category == SPENDING_CUT_CATEGORY), None)
    if category is None or category.mean_14d == 0:
        return []
    mean_14d = horizon_mean_14d(twin, category, horizon_end)
    return [
        Candidate(
            id=f"cand_cut_{category.category}_{round((1 - m) * 100)}",
            kind="reduce_spending",
            label=f"Buy now and spend {pct(1 - m)} less on {category.category}",
            detail=f"{category.category.capitalize()} spending averages "
            f"{money(mean_14d * m)} per 14 days instead of "
            f"{money(mean_14d)}, through {horizon_end}.",
            events=events,
            spending_adjustments=[SpendingAdjustment(category=category.category, multiplier=m)],
            disruption=1 - m,
        )
        for m in SPENDING_CUT_MULTIPLIERS
    ]


def from_savings_candidate(twin: FinancialTwin, events: list[SimulationEvent]) -> list[Candidate]:
    """Only offered when savings can pay on the start date.

    Savings may cover a bill before the purchase date, leaving too little by then;
    run_optimization flags the futures where the purchase would overdraw savings.
    """
    savings = savings_account_id(twin)
    if savings is None or all(e.account_id == savings for e in events):
        return []
    account = next(a for a in twin.accounts if a.id == savings)
    if sum(e.amount for e in events) > account.balance:
        return []
    savings_name = account.name
    return [
        Candidate(
            id="cand_from_savings",
            kind="from_savings",
            label="Pay from savings",
            detail=f"Buy {describe_purchase(events)} on {min(e.date for e in events)} "
            f"from {savings_name} instead, leaving checking alone.",
            events=[e.model_copy(update={"account_id": savings}) for e in events],
            spending_adjustments=[],
            disruption=0,
        )
    ]


def combined_candidates(candidates: list[Candidate]) -> list[Candidate]:
    """Every delay paired with every spending cut, as kind "delay" with a spending adjustment."""
    delays = [c for c in candidates if c.kind == "delay"]
    cuts = [c for c in candidates if c.kind == "reduce_spending"]
    combined = []
    for delay in delays:
        for cut in cuts:
            adjustment = cut.spending_adjustments[0]
            combined.append(
                Candidate(
                    id=f"{delay.id}_{cut.id.removeprefix('cand_')}",
                    kind="delay",
                    label=f"{delay.label} and spend {pct(1 - adjustment.multiplier)} less on "
                    f"{adjustment.category}",
                    detail=f"{delay.detail} {cut.detail}",
                    events=delay.events,
                    spending_adjustments=cut.spending_adjustments,
                    # Days delayed, then the share cut (under 1) breaks ties at the same delay.
                    disruption=delay.disruption + cut.disruption,
                )
            )
    return combined


def generate_candidates(
    twin: FinancialTwin, events: list[SimulationEvent], horizon_end: date
) -> list[Candidate]:
    validate_events(twin, events, horizon_end)
    return [
        buy_now_candidate(twin, events),
        *from_savings_candidate(twin, events),
        *delay_candidates(twin, events, horizon_end),
        *reduce_spending_candidates(twin, events, horizon_end),
    ]


def adjusted_twin(twin: FinancialTwin, adjustments: list[SpendingAdjustment]) -> FinancialTwin:
    """The twin with each adjusted category's mean and spread scaled."""
    if not adjustments:
        return twin
    multipliers = {a.category: a.multiplier for a in adjustments}
    spending = [
        v.model_copy(
            update={
                "mean_14d": v.mean_14d * multipliers[v.category],
                "std_dev_14d": v.std_dev_14d * multipliers[v.category],
            }
        )
        if v.category in multipliers
        else v
        for v in twin.variable_spending
    ]
    return twin.model_copy(update={"variable_spending": spending})


def check_constraints(
    twin: FinancialTwin,
    metrics: ScenarioMetrics,
    baseline: ScenarioMetrics | None = None,
    prob_savings_overdrawn: float = 0,
) -> list[str]:
    """Declared limits this outcome breaks, in words. Empty means every limit is kept.

    With a baseline, a limit the future without the purchase already breaks only
    counts against this outcome if it makes that limit worse: the purchase should
    not be blamed for a problem it did not cause.
    """

    def allowed(risk: float, base_risk: float | None) -> float:
        return max(risk, base_risk) if base_risk is not None else risk

    def versus(base_risk: float | None, limit: float) -> str:
        if base_risk is not None and base_risk > limit:
            return f"up from {pct(base_risk)} without the purchase"
        return f"limit: {pct(limit)}"

    violations = []
    if prob_savings_overdrawn > 0:
        violations.append(
            f"Savings would have to go below $0 to pay for it in {pct(prob_savings_overdrawn)} "
            "of futures, because savings already covered a bill first."
        )
    uncovered = metrics.prob_obligations_uncovered or 0
    base_uncovered = (baseline.prob_obligations_uncovered or 0) if baseline else None
    if uncovered > allowed(0, base_uncovered):
        suffix = f" ({versus(base_uncovered, 0)})" if base_uncovered else ""
        violations.append(
            f"A mandatory bill goes unpaid in {pct(uncovered)} of futures, even after moving "
            f"money from savings{suffix}."
        )
    reserve = reserve_amount(twin)
    base_reserve = baseline.prob_below_reserve if baseline else None
    if reserve > 0 and metrics.prob_below_reserve > allowed(MAX_CONSTRAINT_RISK, base_reserve):
        violations.append(
            f"Checking plus savings dips below the {money(reserve)} emergency reserve in "
            f"{pct(metrics.prob_below_reserve)} of futures "
            f"({versus(base_reserve, MAX_CONSTRAINT_RISK)})."
        )
    declared_floor = any(c.type == "minimum_checking_balance" for c in twin.constraints)
    base_low = baseline.prob_low_balance if baseline else None
    if declared_floor and metrics.prob_low_balance > allowed(MAX_CONSTRAINT_RISK, base_low):
        violations.append(
            f"Checking falls below the {money(low_balance_threshold(twin))} minimum in "
            f"{pct(metrics.prob_low_balance)} of futures ({versus(base_low, MAX_CONSTRAINT_RISK)})."
        )
    return violations


def rank_key(candidate: Candidate, scored: OptimizationCandidate) -> tuple:
    """Constraints kept first, then goals, then risk, then the least disruptive action.

    Probabilities are rounded so float noise cannot reorder otherwise equal options.
    """
    m = scored.metrics
    return (
        not scored.meets_constraints,
        -round(m.prob_goal_met or 0, 3),
        round(m.goal_shortfall, 2),
        round(m.prob_below_reserve, 3),
        round(m.prob_obligations_uncovered or 0, 3),
        round(m.prob_savings_sweep or 0, 3),
        round(m.prob_low_balance, 3),
        KIND_ORDER[candidate.kind],
        candidate.disruption,
    )


def score_candidate(
    twin: FinancialTwin,
    candidate: Candidate,
    horizon_end: date,
    n_simulations: int,
    seed: int,
    baseline: ScenarioMetrics | None,
) -> tuple[ScenarioMetrics, OptimizationCandidate]:
    """Run one candidate's Monte Carlo and check it against the declared limits.

    With no baseline given, this run's future without the purchase becomes the baseline.
    """
    mc = run_monte_carlo(
        adjusted_twin(twin, candidate.spending_adjustments),
        candidate.events,
        horizon_end,
        n_simulations,
        seed,
    )
    if baseline is None:
        baseline = to_metrics(mc.baseline)
    metrics = to_metrics(mc.counterfactual)
    violations = check_constraints(twin, metrics, baseline, mc.counterfactual.prob_savings_overdrawn)
    return baseline, OptimizationCandidate(
        id=candidate.id,
        kind=candidate.kind,
        label=candidate.label,
        detail=candidate.detail,
        events=candidate.events,
        spending_adjustments=candidate.spending_adjustments,
        metrics=metrics,
        meets_constraints=not violations,
        violations=violations,
    )


def run_optimization(
    twin: FinancialTwin,
    request: OptimizationRequest,
    n_simulations: int = DEFAULT_OPTIMIZE_SIMULATIONS,
    seed: int | None = None,
) -> OptimizationResponse:
    """Score every candidate on the same simulated futures and rank them.

    seed=None draws one fresh seed for the whole call, so candidates still share futures.
    """
    horizon_end = resolve_horizon_end(twin, request.horizon_end)
    candidates = generate_candidates(twin, request.events, horizon_end)
    shared_seed = seed if seed is not None else random.randrange(2**32)

    # buy_now comes first and runs on the unadjusted twin, so its baseline is the real one.
    first, *others = candidates
    baseline, buy_now = score_candidate(twin, first, horizon_end, n_simulations, shared_seed, None)

    def score_all(options: list[Candidate]) -> list[tuple[Candidate, OptimizationCandidate]]:
        return [
            (c, score_candidate(twin, c, horizon_end, n_simulations, shared_seed, baseline)[1])
            for c in options
        ]

    scored = [(first, buy_now), *score_all(others)]
    tried_combined = not any(s.meets_constraints for _, s in scored)
    if tried_combined:
        scored += score_all(combined_candidates(candidates))

    ordered = [s for _, s in sorted(scored, key=lambda pair: rank_key(*pair))]
    recommended = next((c for c in ordered if c.meets_constraints), None)

    return OptimizationResponse(
        optimization_id=f"opt_{uuid4().hex[:12]}",
        user_id=twin.user_id,
        request=request,
        horizon_end=horizon_end,
        baseline=baseline,
        candidates=ordered,
        recommended_id=recommended.id if recommended else None,
        summary=build_optimization_summary(
            twin, baseline, buy_now, recommended, ordered, check_constraints(twin, baseline)
        ),
        assumptions=[
            *build_optimization_assumptions(
                twin, horizon_end, n_simulations, MAX_CONSTRAINT_RISK, MAX_DELAY_PAYDAYS
            ),
            *commitments_assumption(twin, horizon_end),
            *([COMBINED_ASSUMPTION] if tried_combined else []),
        ],
        num_simulations=n_simulations,
    )
