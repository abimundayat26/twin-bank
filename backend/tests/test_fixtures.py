from backend.fixtures import load_simulation, load_twin


def test_twin_fixture_validates():
    twin = load_twin()
    assert twin.user_id == "alex"
    assert twin.total_balance == 2840.0


def test_twin_has_income_with_uncertainty():
    income = load_twin().income
    assert len(income) >= 1
    for stream in income:
        assert stream.expected_amount > 0
        assert stream.uncertainty > 0
        assert stream.provenance == "observed"


def test_twin_has_required_obligations():
    obligations = {o.id: o for o in load_twin().obligations}
    assert "obl_rent" in obligations
    assert obligations["obl_rent"].mandatory is True
    assert obligations["obl_rent"].provenance == "observed"


def test_twin_flags_ambiguous_recurring_transfer():
    """The recurring transfer of unclear purpose should read as soft, not a hard bill."""
    obligations = {o.id: o for o in load_twin().obligations}
    transfer = obligations["obl_mystery_transfer"]
    assert transfer.expected_amount == 75.0
    assert transfer.mandatory is False
    assert transfer.confidence < 0.7
    assert transfer.provenance == "observed"


def test_twin_has_expected_spending_categories():
    spending = {s.category: s for s in load_twin().variable_spending}
    for category in ("groceries", "discretionary"):
        assert category in spending
        assert spending[category].mean_14d > 0
        assert spending[category].provenance == "observed"


def test_twin_has_declared_goal_and_reserve_constraint():
    twin = load_twin()

    assert len(twin.goals) >= 1
    housing_goal = twin.goals[0]
    assert housing_goal.target_amount > 0
    assert housing_goal.provenance == "declared"

    assert len(twin.constraints) >= 1
    reserve = next(c for c in twin.constraints if c.type == "minimum_reserve")
    assert reserve.amount > 0
    assert reserve.provenance == "declared"


def test_simulation_fixture_validates():
    sim = load_simulation()
    assert sim.user_id == "alex"
    assert sim.is_mock is True
    assert sim.request.events[0].amount == 800.0


def test_simulation_fixture_references_twin_account():
    account_ids = {a.id for a in load_twin().accounts}
    for event in load_simulation().request.events:
        assert event.account_id in account_ids
