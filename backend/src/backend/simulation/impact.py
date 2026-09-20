"""The Impact Score: how hard a purchase hits the risk metrics.

`frontend/SPEC.md` section 7.3 fixes the rules; this module is the one place the
thresholds live (assumption A3, they are tunable constants). Everything here is a
pure function of two `ScenarioMetrics`, so the Simulator formats a level and its
reasons instead of computing a score of its own (G-6, P2).

A metric that is `None` on either side is skipped: a mock result that never
computed `prob_goal_met` must not read as "the goal is unaffected".
"""

from dataclasses import dataclass
from typing import Literal

from backend.schemas import ImpactAssessment, ScenarioMetrics

MAX_REASONS = 3

Level = Literal["low", "moderate", "high"]


@dataclass(frozen=True)
class Rule:
    """One row of section 7.3's High or Moderate table.

    `threshold` is compared against the unrounded difference
    `counterfactual - baseline` (G-4). A rule whose metric falls rather than rises
    carries a negative threshold and fires at or below it.
    """

    id: str
    metric: str
    level: Level
    threshold: float
    falls: bool = False
    strict: bool = False

    def fires(self, delta: float) -> bool:
        if self.falls:
            return delta <= self.threshold
        return delta > self.threshold if self.strict else delta >= self.threshold


# Order matters twice over: the first firing rule's level wins, and reasons are
# rendered in this order, so the most severe one a reader sees first.
RULES: tuple[Rule, ...] = (
    Rule("H1", "prob_low_balance", "high", 0.25),
    Rule("H2", "prob_below_reserve", "high", 0.10),
    Rule("H3", "prob_goal_met", "high", -0.25, falls=True),
    Rule("H4", "prob_obligations_uncovered", "high", 0.02),
    Rule("H5", "goal_shortfall", "high", 250.0),
    Rule("M1", "prob_low_balance", "moderate", 0.05),
    Rule("M2", "prob_below_reserve", "moderate", 0.02),
    Rule("M3", "prob_goal_met", "moderate", -0.05, falls=True),
    Rule("M4", "prob_obligations_uncovered", "moderate", 0.0, strict=True),
    Rule("M5", "goal_shortfall", "moderate", 0.0, strict=True),
    Rule("M6", "prob_savings_sweep", "moderate", 0.05),
)

# One template per metric. A rule only ever fires in the direction its template
# describes, so the wording needs no branch.
TEMPLATES: dict[str, str] = {
    "prob_low_balance": "Chance of low balance rises by {n} points",
    "prob_below_reserve": "Chance of dipping into your reserve rises by {n} points",
    "prob_goal_met": "Chance your goal is met falls by {n} points",
    "prob_obligations_uncovered": "A bill goes uncovered in {n}% more futures",
    "goal_shortfall": "Goal is short by ${n} more",
    # Section 7.3 lists no template for M6; this mirrors the Simulator's row label.
    "prob_savings_sweep": "Chance of paying a bill out of savings rises by {n} points",
}

MONEY_METRICS = frozenset({"goal_shortfall"})


def delta(baseline: ScenarioMetrics, counterfactual: ScenarioMetrics, metric: str) -> float | None:
    """`counterfactual - baseline`, or None when either side did not compute it."""
    before = getattr(baseline, metric)
    after = getattr(counterfactual, metric)
    if before is None or after is None:
        return None
    return after - before


def magnitude(metric: str, value: float) -> str:
    """The rounded size of a difference the reader sees.

    Rounded half away from zero (G-2), and never below 1: the rule only fires on a
    strictly nonzero difference, so rendering it as "0 points" would report a real
    risk as no risk (the same reasoning as G-3).
    """
    size = abs(value) if metric in MONEY_METRICS else abs(value) * 100
    rounded = max(1, int(size + 0.5))
    return f"{rounded:,}"


def assess_impact(baseline: ScenarioMetrics, counterfactual: ScenarioMetrics) -> ImpactAssessment:
    """Score one simulation: High, Moderate or Low, with the deltas that earned it."""
    fired = [
        rule
        for rule in RULES
        if (d := delta(baseline, counterfactual, rule.metric)) is not None and rule.fires(d)
    ]

    level: Level = "low"
    if any(rule.level == "high" for rule in fired):
        level = "high"
    elif fired:
        level = "moderate"

    reasons: list[str] = []
    seen: set[str] = set()
    for rule in fired:
        if rule.metric in seen:
            continue
        seen.add(rule.metric)
        d = delta(baseline, counterfactual, rule.metric)
        assert d is not None  # fired implies a computed difference
        reasons.append(TEMPLATES[rule.metric].format(n=magnitude(rule.metric, d)))
        if len(reasons) == MAX_REASONS:
            break

    return ImpactAssessment(level=level, reasons=reasons)
