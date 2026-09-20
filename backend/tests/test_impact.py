"""Impact Score rules from frontend/SPEC.md section 7.3."""

from datetime import date

import pytest

from backend.fixtures import load_twin
from backend.schemas import ScenarioMetrics, SimulationEvent, SimulationRequest
from backend.simulation import run_simulation
from backend.simulation.impact import MAX_REASONS, RULES, TEMPLATES, assess_impact

SEED = 1

# Alex's seeded baseline, section 7.4. The deltas below are the ones section 7.3
# recorded for four purchases, so this table is the spec's own worked examples.
BASELINE = dict(
    ending_balance=3396.0,
    min_balance=2508.0,
    prob_low_balance=0.015,
    prob_below_reserve=0.0,
    goal_shortfall=0.0,
    obligations_covered=True,
    prob_obligations_uncovered=0.0,
    prob_goal_met=0.768,
    prob_savings_sweep=0.0,
)


def metrics(**overrides) -> ScenarioMetrics:
    return ScenarioMetrics(**{**BASELINE, **overrides})


def shifted(**deltas) -> ScenarioMetrics:
    """The counterfactual that differs from BASELINE by exactly these deltas."""
    return metrics(**{field: BASELINE[field] + d for field, d in deltas.items()})


ALEX_CASES = [
    ("$20", dict(prob_low_balance=0.007, prob_goal_met=-0.017), "low"),
    ("$200", dict(prob_low_balance=0.075, prob_goal_met=-0.168), "moderate"),
    (
        "$800",
        dict(
            prob_low_balance=0.951,
            prob_below_reserve=0.175,
            prob_goal_met=-0.668,
            goal_shortfall=504.0,
        ),
        "high",
    ),
    (
        "$2,500",
        dict(
            prob_low_balance=0.985,
            prob_below_reserve=1.0,
            prob_goal_met=-0.768,
            goal_shortfall=2204.0,
            prob_obligations_uncovered=0.367,
        ),
        "high",
    ),
]


@pytest.mark.parametrize("label,deltas,expected", ALEX_CASES, ids=[c[0] for c in ALEX_CASES])
def test_alex_purchases_score_as_the_spec_recorded(label, deltas, expected):
    assert assess_impact(metrics(), shifted(**deltas)).level == expected


def test_an_unchanged_future_is_low_with_no_reasons():
    assessment = assess_impact(metrics(), metrics())
    assert assessment.level == "low"
    assert assessment.reasons == []


@pytest.mark.parametrize("rule", RULES, ids=[rule.id for rule in RULES])
def test_each_rule_fires_at_its_threshold(rule):
    """Every row of the High and Moderate tables, at the value it is written for."""
    at_threshold = rule.threshold if rule.threshold else (-0.001 if rule.falls else 0.001)
    assert assess_impact(metrics(), shifted(**{rule.metric: at_threshold})).level == rule.level


@pytest.mark.parametrize("rule", [r for r in RULES if r.level == "moderate"], ids=lambda r: r.id)
def test_a_difference_just_under_a_moderate_threshold_stays_low(rule):
    if rule.strict:  # M4 and M5 fire on anything above zero, so there is no gap below them
        assert assess_impact(metrics(), shifted(**{rule.metric: 0.0})).level == "low"
        return
    under = -abs(rule.threshold) + 0.001 if rule.falls else rule.threshold - 0.001
    assert assess_impact(metrics(), shifted(**{rule.metric: under})).level == "low"


def test_a_metric_missing_on_either_side_is_skipped():
    """A mock result that never computed a probability must not read as "unaffected"."""
    baseline = metrics(prob_goal_met=None, prob_obligations_uncovered=None, prob_savings_sweep=None)
    counterfactual = metrics(
        prob_goal_met=None,
        prob_obligations_uncovered=None,
        prob_savings_sweep=None,
        goal_shortfall=0.0,
    )
    assert assess_impact(baseline, counterfactual).level == "low"

    # Computed on one side only is still not a difference anyone can measure.
    assert assess_impact(metrics(prob_goal_met=None), metrics(prob_goal_met=0.1)).level == "low"


def test_savings_sweep_never_scores_higher_than_moderate():
    assessment = assess_impact(metrics(), shifted(prob_savings_sweep=1.0))
    assert assessment.level == "moderate"
    assert assessment.reasons == ["Chance of paying a bill out of savings rises by 100 points"]


def test_reasons_are_most_severe_first_and_capped():
    assessment = assess_impact(metrics(), shifted(**ALEX_CASES[3][1]))
    assert assessment.level == "high"
    assert assessment.reasons == [
        "Chance of low balance rises by 99 points",
        "Chance of dipping into your reserve rises by 100 points",
        "Chance your goal is met falls by 77 points",
    ]
    assert len(assessment.reasons) == MAX_REASONS


def test_one_reason_per_metric():
    """A metric past both its High and its Moderate threshold is still one reason."""
    assessment = assess_impact(metrics(), shifted(prob_low_balance=0.5))
    assert assessment.reasons == ["Chance of low balance rises by 50 points"]


def test_money_reasons_are_whole_dollars_with_separators():
    assessment = assess_impact(metrics(), shifted(goal_shortfall=2204.4))
    assert assessment.reasons == ["Goal is short by $2,204 more"]


def test_a_real_difference_never_renders_as_zero():
    """G-3's reasoning: a risk that exists must not be reported as none of it."""
    assessment = assess_impact(metrics(), shifted(prob_obligations_uncovered=0.0004))
    assert assessment.reasons == ["A bill goes uncovered in 1% more futures"]


def test_every_rule_has_a_template():
    assert {rule.metric for rule in RULES} <= set(TEMPLATES)


def test_the_laptop_scores_high_end_to_end():
    """The demo story: $800 on Alex's twin is clearly risky, with reasons (section 18)."""
    twin = load_twin()
    request = SimulationRequest(
        user_id=twin.user_id,
        events=[
            SimulationEvent(
                type="purchase",
                description="Laptop",
                amount=800.0,
                date=date(2026, 9, 20),
                account_id="acc_checking",
            )
        ],
        horizon_end=twin.goals[0].deadline,
    )
    impact = run_simulation(twin, request, seed=SEED).impact
    assert impact is not None
    assert impact.level == "high"
    assert impact.reasons
    assert len(impact.reasons) <= MAX_REASONS
