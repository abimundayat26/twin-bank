from backend.fixtures import load_simulation, load_twin


def test_twin_fixture_validates():
    twin = load_twin()
    assert twin.user_id == "alex"
    assert twin.total_balance == 2840.0


def test_simulation_fixture_validates():
    sim = load_simulation()
    assert sim.user_id == "alex"
    assert sim.is_mock is True
    assert sim.request.events[0].amount == 800.0


def test_simulation_fixture_references_twin_account():
    account_ids = {a.id for a in load_twin().accounts}
    for event in load_simulation().request.events:
        assert event.account_id in account_ids
