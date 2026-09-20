"""Earliest-date search, CM-2 and A10 from frontend/SPEC.md section 10."""

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from backend.fixtures import load_twin
from backend.main import app
from backend.schemas import EarliestDateResponse, Goal, SimulationEvent
from backend.simulation import earliest_date as ed
from backend.simulation.earliest_date import (
    STEP_DAYS,
    TOLERANCE,
    GoalNotEligible,
    GoalNotFound,
    find_earliest_date,
)
from backend.simulation.engine import MAX_HORIZON_DAYS, SimulationError

client = TestClient(app)

SEED = 1
RUNS = 120  # enough for a stable answer, small enough to keep the suite quick

LAPTOP = SimulationEvent(
    type="purchase",
    description="Laptop",
    amount=800.0,
    date=date(2026, 9, 20),
    account_id="acc_checking",
)
GOAL_ID = "goal_summer_housing"

LAPTOP_BODY = {
    "events": [
        {
            "type": "purchase",
            "description": "Laptop",
            "amount": 800,
            "date": "2026-09-20",
            "account_id": "acc_checking",
        }
    ]
}


def search(twin=None, event=LAPTOP, goal_id=GOAL_ID) -> EarliestDateResponse:
    return find_earliest_date(
        twin if twin is not None else load_twin(), goal_id, [event], n_simulations=RUNS, seed=SEED
    )


def test_the_laptop_moves_the_goal_to_a_30_day_step():
    result = search()
    assert result.goal_id == GOAL_ID
    assert result.original_deadline == date(2027, 5, 1)
    assert result.earliest_deadline is not None
    days = (result.earliest_deadline - result.original_deadline).days
    assert days % STEP_DAYS == 0  # candidates are D0 + 30k only (CM-2)
    assert days > 0  # an $800 purchase does cost this goal something


def test_the_answer_is_within_the_tolerance_of_the_baseline_chance():
    result = search()
    assert result.baseline_prob_goal_met is not None
    assert result.prob_goal_met_at_earliest is not None
    assert result.prob_goal_met_at_earliest >= result.baseline_prob_goal_met - TOLERANCE


def test_the_step_before_the_answer_does_not_qualify():
    """"Earliest" has to mean it: one step sooner must still fall short (CM-2)."""
    result = search()
    assert result.earliest_deadline is not None
    assert result.baseline_prob_goal_met is not None
    previous = result.earliest_deadline - timedelta(days=STEP_DAYS)
    _, chance = ed.chances_at(load_twin(), GOAL_ID, previous, [LAPTOP], RUNS, SEED)
    assert chance is not None
    assert chance < result.baseline_prob_goal_met - TOLERANCE


def test_a_purchase_that_barely_touches_the_goal_needs_no_move():
    """A trivial purchase qualifies at D0 itself, so nothing is sacrificed (CM-2).

    Deliberately far below the 0.02 tolerance: a purchase whose cost is near it lands
    either side of the line depending on how many futures were run.
    """
    small = LAPTOP.model_copy(update={"description": "Coffee", "amount": 1.0})
    result = find_earliest_date(load_twin(), GOAL_ID, [small], n_simulations=400, seed=SEED)
    assert result.earliest_deadline == result.original_deadline


def test_a_purchase_no_deadline_can_absorb_has_no_earliest_date():
    """CM-2: nothing inside the 730-day limit qualifies, so the answer is null."""
    huge = LAPTOP.model_copy(update={"description": "Car", "amount": 50_000.0})
    result = search(event=huge)
    assert result.earliest_deadline is None
    assert result.prob_goal_met_at_earliest is None
    assert result.baseline_prob_goal_met is not None


def test_the_search_never_looks_past_the_two_year_limit():
    twin = load_twin()
    result = search(twin=twin)
    assert result.searched_until == twin.as_of + timedelta(days=MAX_HORIZON_DAYS)
    assert result.earliest_deadline is None or result.earliest_deadline <= result.searched_until


def test_the_search_is_deterministic_under_a_seed():
    assert search() == search()


def test_only_the_earliest_deadline_goal_is_eligible():
    twin = load_twin()
    later = Goal(
        id="goal_laptop_fund",
        name="Laptop fund",
        target_amount=500.0,
        deadline=date(2027, 8, 1),
        current_amount=0.0,
    )
    with_both = twin.model_copy(update={"goals": [*twin.goals, later]})
    with pytest.raises(GoalNotEligible):
        search(twin=with_both, goal_id="goal_laptop_fund")
    assert search(twin=with_both).earliest_deadline is not None


def test_an_unknown_goal_is_not_found():
    with pytest.raises(GoalNotFound):
        search(goal_id="goal_nope")


def test_an_event_the_engine_rejects_is_a_simulation_error():
    unknown_account = LAPTOP.model_copy(update={"account_id": "acc_nope"})
    with pytest.raises(SimulationError):
        search(event=unknown_account)


AFTER_DEADLINE = LAPTOP.model_copy(update={"date": date(2027, 6, 15)})  # goal is due 2027-05-01


def test_a_purchase_after_the_deadline_costs_the_goal_nothing():
    """It used to raise "event date is after horizon_end": the run stopped at the deadline."""
    result = search(event=AFTER_DEADLINE)
    assert result.earliest_deadline == result.original_deadline
    assert result.prob_goal_met_at_earliest == result.baseline_prob_goal_met


def test_a_purchase_on_the_deadline_itself_still_costs_the_goal_something():
    on_deadline = LAPTOP.model_copy(update={"date": date(2027, 5, 1)})
    result = search(event=on_deadline)
    assert result.earliest_deadline is not None
    assert result.earliest_deadline > result.original_deadline


def test_chances_at_runs_far_enough_to_hold_a_purchase_after_the_deadline():
    without, with_purchase = ed.chances_at(
        load_twin(), GOAL_ID, date(2027, 5, 1), [AFTER_DEADLINE], RUNS, SEED
    )
    assert without is not None and with_purchase == without


def test_a_purchase_beyond_the_two_year_limit_is_still_rejected():
    too_far = LAPTOP.model_copy(update={"date": load_twin().as_of + timedelta(days=MAX_HORIZON_DAYS + 1)})
    with pytest.raises(SimulationError):
        search(event=too_far)


def test_route_accepts_a_purchase_after_the_deadline(monkeypatch):
    monkeypatch.setattr(ed, "SEARCH_SIMULATIONS", RUNS)
    body = {"events": [{**LAPTOP_BODY["events"][0], "date": "2027-06-15"}]}
    response = client.post(f"/twin/alex/goals/{GOAL_ID}/earliest-date", json=body)
    assert response.status_code == 200
    result = EarliestDateResponse.model_validate(response.json())
    assert result.earliest_deadline == result.original_deadline == date(2027, 5, 1)


def test_route_returns_the_search(monkeypatch):
    monkeypatch.setattr(ed, "SEARCH_SIMULATIONS", RUNS)
    response = client.post(f"/twin/alex/goals/{GOAL_ID}/earliest-date", json=LAPTOP_BODY)
    assert response.status_code == 200
    result = EarliestDateResponse.model_validate(response.json())
    assert result.goal_id == GOAL_ID
    assert result.original_deadline == date(2027, 5, 1)


def test_route_404s_for_an_unknown_user_or_goal(monkeypatch):
    monkeypatch.setattr(ed, "SEARCH_SIMULATIONS", RUNS)
    assert client.post("/twin/nobody/goals/g/earliest-date", json=LAPTOP_BODY).status_code == 404
    unknown_goal = client.post("/twin/alex/goals/goal_nope/earliest-date", json=LAPTOP_BODY)
    assert unknown_goal.status_code == 404


def test_route_422s_for_a_later_goal_and_for_a_bad_event(monkeypatch):
    monkeypatch.setattr(ed, "SEARCH_SIMULATIONS", RUNS)
    twin = load_twin()
    later = Goal(
        id="goal_laptop_fund",
        name="Laptop fund",
        target_amount=500.0,
        deadline=date(2027, 8, 1),
        current_amount=0.0,
    )
    client.put(
        "/twin/alex/goals",
        json={
            "goals": [g.model_dump(mode="json") for g in [*twin.goals, later]],
            "constraints": [c.model_dump(mode="json") for c in twin.constraints],
        },
    )
    not_earliest = client.post(
        "/twin/alex/goals/goal_laptop_fund/earliest-date", json=LAPTOP_BODY
    )
    assert not_earliest.status_code == 422

    bad_account = {"events": [{**LAPTOP_BODY["events"][0], "account_id": "acc_nope"}]}
    assert (
        client.post(f"/twin/alex/goals/{GOAL_ID}/earliest-date", json=bad_account).status_code
        == 422
    )
