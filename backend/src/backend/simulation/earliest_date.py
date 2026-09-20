"""How far a goal's deadline has to move before a purchase stops costing it (CM-2).

`frontend/SPEC.md` section 10 fixes the search: candidate deadlines are `D0 + 30k`
days, no later than `as_of + 730`, and the answer is the smallest `k` whose chance
of meeting the goal *with the purchase* is within 0.02 of the chance without it at
the original deadline (A10). Bisection keeps that to about seven Monte Carlo runs.

Every run is seeded identically, so all of them sample the same futures and a
candidate never wins on luck alone. Deterministic code, never a model
(`CLAUDE.md`, LLM Responsibilities).
"""

from datetime import date, timedelta

from backend.schemas import EarliestDateResponse, FinancialTwin, SimulationEvent
from backend.simulation.engine import MAX_HORIZON_DAYS, SimulationError
from backend.simulation.monte_carlo import DEFAULT_SIMULATIONS, run_monte_carlo

STEP_DAYS = 30
TOLERANCE = 0.02
# Runs per candidate deadline. About seven candidates are tried, so this is the one
# knob that decides how long a search takes; tests turn it down.
SEARCH_SIMULATIONS = DEFAULT_SIMULATIONS


class GoalNotFound(LookupError):
    """No goal with that id on this twin."""


class GoalNotEligible(ValueError):
    """Only the earliest-deadline goal can be moved in v1 (CM-2)."""


def earliest_goal(twin: FinancialTwin):
    """The goal the search is allowed to move: the one due first.

    `prob_goal_met` only covers goals due inside the horizon, so a later goal has no
    baseline chance to compare against -- hence the v1 restriction.
    """
    return min(twin.goals, key=lambda g: (g.deadline, g.id), default=None)


def find_goal(twin: FinancialTwin, goal_id: str):
    goal = next((g for g in twin.goals if g.id == goal_id), None)
    if goal is None:
        raise GoalNotFound(goal_id)
    first = earliest_goal(twin)
    if first is None or goal.id != first.id:
        raise GoalNotEligible(
            f"Goal '{goal_id}' is not the earliest-deadline goal; only "
            f"'{first.id if first else ''}' can be moved in v1"
        )
    return goal


def moved(twin: FinancialTwin, goal_id: str, deadline: date) -> FinancialTwin:
    return twin.model_copy(
        update={
            "goals": [
                g.model_copy(update={"deadline": deadline}) if g.id == goal_id else g
                for g in twin.goals
            ]
        }
    )


def chances_at(
    twin: FinancialTwin,
    goal_id: str,
    deadline: date,
    events: list[SimulationEvent],
    n_simulations: int,
    seed: int | None,
) -> tuple[float | None, float | None]:
    """(without the purchase, with it) for this goal at this deadline.

    Read per goal rather than from `prob_goal_met`, which is "every goal due in the
    horizon": moving this deadline later pulls other goals into the window, and their
    misses are not this goal's answer.

    The run lasts until the goal's deadline or the latest purchase, whichever is later:
    the engine rejects an event past its horizon, and a purchase dated after the
    deadline simply cannot cost the goal anything.
    """
    horizon = max([deadline, *(e.date for e in events)])
    mc = run_monte_carlo(
        moved(twin, goal_id, deadline), events, horizon, n_simulations, seed
    )

    def prob(aggregate) -> float | None:
        return next((g.prob_met for g in aggregate.goals if g.goal_id == goal_id), None)

    return prob(mc.baseline), prob(mc.counterfactual)


def find_earliest_date(
    twin: FinancialTwin,
    goal_id: str,
    events: list[SimulationEvent],
    n_simulations: int | None = None,
    seed: int | None = None,
) -> EarliestDateResponse:
    """The first deadline at which the purchase costs the goal little enough (CM-2).

    `earliest_deadline` is None when no candidate inside the 730-day limit qualifies.
    It can also be the goal's current deadline: a purchase that barely touches the
    goal needs no sacrifice at all, and saying so is more honest than the next month.
    """
    goal = find_goal(twin, goal_id)
    n_simulations = SEARCH_SIMULATIONS if n_simulations is None else n_simulations
    original = goal.deadline
    searched_until = twin.as_of + timedelta(days=MAX_HORIZON_DAYS)
    if original > searched_until:  # a goal already beyond what the engine will simulate
        raise SimulationError(
            f"Goal '{goal_id}' deadline {original} is more than {MAX_HORIZON_DAYS} days "
            f"after as_of {twin.as_of}"
        )

    baseline, with_purchase = chances_at(twin, goal_id, original, events, n_simulations, seed)
    if baseline is None:
        raise SimulationError(f"Goal '{goal_id}' has no chance of being met to compare against")
    target = baseline - TOLERANCE

    def qualifies(chance: float | None) -> bool:
        return chance is not None and chance >= target

    answer: tuple[date, float | None] | None = None
    if qualifies(with_purchase):
        answer = (original, with_purchase)
    else:
        # Bisection assumes a later deadline is never worse for the goal, which is what
        # more time to save means. `high` is the last candidate inside the limit.
        high = (searched_until - original).days // STEP_DAYS
        low = 1
        while low <= high:
            k = (low + high) // 2
            candidate = original + timedelta(days=STEP_DAYS * k)
            _, chance = chances_at(twin, goal_id, candidate, events, n_simulations, seed)
            if qualifies(chance):
                answer = (candidate, chance)
                high = k - 1
            else:
                low = k + 1

    return EarliestDateResponse(
        goal_id=goal_id,
        original_deadline=original,
        earliest_deadline=answer[0] if answer else None,
        baseline_prob_goal_met=baseline,
        prob_goal_met_at_earliest=answer[1] if answer else None,
        searched_until=searched_until,
    )
