"""User answers are saved to a file and survive a server restart."""

from datetime import date

from backend import twin_store
from backend.schemas import FinancialConstraint, Goal, OneTimeObligation

TRANSFER = "obl_online_transfer_to"
GOAL = Goal(id="goal_car", name="Car repair", target_amount=600, deadline=date(2027, 1, 15))
RESERVE = FinancialConstraint(
    id="con_reserve", type="minimum_reserve", amount=1200, description="Keep $1,200."
)
TUITION = OneTimeObligation(
    id="one_tuition",
    name="Spring tuition",
    amount=1200,
    due_date=date(2027, 1, 15),
    account_id="acc_checking",
)


def restart() -> None:
    """What a new process sees: nothing in memory, the file not yet read."""
    twin_store.reset()
    twin_store._loaded = False


def minimum_balance(twin):
    return next(c.amount for c in twin.constraints if c.type == "minimum_checking_balance")


def test_answers_survive_a_restart():
    twin_store.declare_category(TRANSFER, "savings_transfer")
    twin_store.set_goals([GOAL], [RESERVE])
    twin_store.set_minimum_checking_balance(300)
    before = twin_store.get_twin()

    restart()
    after = twin_store.get_twin()

    assert after == before
    assert next(o for o in after.obligations if o.id == TRANSFER).declared_category == "savings_transfer"
    assert after.goals == [GOAL]
    assert minimum_balance(after) == 300


def test_goals_without_a_checking_minimum_are_saved():
    twin_store.set_goals([GOAL], [RESERVE])
    restart()
    assert twin_store.get_twin().goals == [GOAL]


def test_no_file_means_no_answers():
    fixture = twin_store.get_twin()
    restart()
    assert twin_store.get_twin() == fixture
    assert not twin_store.answers_path.exists()


def test_corrupt_file_is_ignored():
    fixture = twin_store.get_twin()
    twin_store.answers_path.write_text("{not json")
    restart()
    assert twin_store.get_twin() == fixture


def test_invalid_answers_are_ignored():
    fixture = twin_store.get_twin()
    twin_store.answers_path.write_text('{"declared_categories": {"x": "not_a_category"}}')
    restart()
    assert twin_store.get_twin() == fixture


def test_empty_path_keeps_answers_in_memory_only(monkeypatch, tmp_path):
    monkeypatch.setattr(twin_store, "answers_path", None)
    twin_store.set_minimum_checking_balance(300)
    assert minimum_balance(twin_store.get_twin()) == 300
    assert list(tmp_path.iterdir()) == []


def test_env_var_chooses_the_path(monkeypatch, tmp_path):
    monkeypatch.setenv("TWIN_ANSWERS_PATH", str(tmp_path / "elsewhere.json"))
    assert twin_store._answers_path_from_env() == tmp_path / "elsewhere.json"
    monkeypatch.setenv("TWIN_ANSWERS_PATH", "")
    assert twin_store._answers_path_from_env() is None
    monkeypatch.delenv("TWIN_ANSWERS_PATH")
    assert twin_store._answers_path_from_env() == twin_store.DEFAULT_ANSWERS_PATH


def test_a_failed_save_still_applies_the_answer(monkeypatch, tmp_path):
    blocker = tmp_path / "a_file"
    blocker.write_text("")
    monkeypatch.setattr(twin_store, "answers_path", blocker / "answers.json")
    twin = twin_store.set_minimum_checking_balance(300)
    assert minimum_balance(twin) == 300


# --- Confirmed one-time obligations ----------------------------------------------


def test_a_confirmed_obligation_survives_a_restart():
    twin_store.set_goals([GOAL], [RESERVE], [TUITION])
    restart()
    assert twin_store.get_twin().one_time_obligations == [TUITION]


def test_leaving_obligations_out_keeps_the_ones_already_confirmed():
    twin_store.set_goals([GOAL], [RESERVE], [TUITION])
    twin_store.set_goals([GOAL], [RESERVE])
    assert twin_store.get_twin().one_time_obligations == [TUITION]


def test_an_empty_list_clears_them():
    twin_store.set_goals([GOAL], [RESERVE], [TUITION])
    twin_store.set_goals([GOAL], [RESERVE], [])
    assert twin_store.get_twin().one_time_obligations == []
