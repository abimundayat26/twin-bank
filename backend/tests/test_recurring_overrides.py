"""Edits to a detected recurring obligation survive the rebuild that produced it.

Recurring obligations are re-derived from transactions, so an edit written onto the
built twin would be undone by the next rebuild. These cover the override layer that
holds them instead (frontend/SPEC.md PER-1 to PER-8).
"""

import json

import pytest
from pydantic import ValidationError

from backend import twin_store
from backend.schemas import RecurringObligationCreate
from backend.twin_store import RecurringOverride

RENT = "obl_hokie_property_mgmt_rent"
TRANSFER = "obl_online_transfer_to"


def restart() -> None:
    """What a new process sees: nothing in memory, the file not yet read."""
    twin_store.reset()
    twin_store._loaded = False


def obligation(obligation_id: str):
    return next(o for o in twin_store.get_twin().obligations if o.id == obligation_id)


# --- Applying an override -------------------------------------------------------


def test_an_edited_amount_replaces_the_detected_one():
    twin_store.override_recurring(RENT, RecurringOverride(expected_amount=700))
    assert obligation(RENT).expected_amount == 700


def test_pausing_leaves_every_other_field_alone():
    before = obligation(RENT)
    twin_store.override_recurring(RENT, RecurringOverride(active=False))
    after = obligation(RENT)
    assert after.active is False
    assert after == before.model_copy(update={"active": False})


def test_an_obligation_with_no_override_is_untouched():
    twin_store.override_recurring(RENT, RecurringOverride(active=False))
    assert obligation(TRANSFER) == next(
        o for o in twin_store.load_source_twin().obligations if o.id == TRANSFER
    )


def test_later_edits_merge_rather_than_replace():
    twin_store.override_recurring(RENT, RecurringOverride(expected_amount=700))
    twin_store.override_recurring(RENT, RecurringOverride(active=False))
    after = obligation(RENT)
    assert after.expected_amount == 700 and after.active is False


def test_an_override_and_a_category_answer_both_apply():
    twin_store.declare_category(TRANSFER, "savings_transfer")
    twin_store.override_recurring(TRANSFER, RecurringOverride(due_day=3))
    after = obligation(TRANSFER)
    assert after.declared_category == "savings_transfer" and after.due_day == 3


# --- Provenance (PER-5) ---------------------------------------------------------


@pytest.mark.parametrize(
    "changes",
    [
        RecurringOverride(name="Rent"),
        RecurringOverride(expected_amount=700),
        RecurringOverride(due_day=3),
    ],
)
def test_correcting_a_detected_value_makes_it_the_users_figure(changes):
    assert obligation(RENT).provenance == "observed"
    twin_store.override_recurring(RENT, changes)
    assert obligation(RENT).provenance == "declared"


def test_pausing_alone_does_not_change_provenance():
    """A paused rent is still the rent that was observed."""
    twin_store.override_recurring(RENT, RecurringOverride(active=False))
    assert obligation(RENT).provenance == "observed"


# --- An override with nothing to apply to (PER-2) -------------------------------


def test_an_override_for_a_vanished_obligation_is_kept_but_not_applied(monkeypatch):
    twin_store.override_recurring(RENT, RecurringOverride(expected_amount=700))
    source = twin_store.load_source_twin()
    without_rent = source.model_copy(
        update={"obligations": [o for o in source.obligations if o.id != RENT]}
    )
    monkeypatch.setattr(twin_store, "load_source_twin", lambda: without_rent)

    twin = twin_store.get_twin()

    assert all(o.id != RENT for o in twin.obligations)
    assert twin_store.recurring_overrides[RENT].expected_amount == 700


def test_an_unknown_obligation_cannot_be_overridden():
    with pytest.raises(twin_store.UnknownObligation):
        twin_store.override_recurring("obl_nope", RecurringOverride(active=False))
    assert "obl_nope" not in twin_store.recurring_overrides


# --- Validate before mutating (PER-7) -------------------------------------------


def test_an_empty_change_is_rejected_and_stores_nothing():
    with pytest.raises(twin_store.InvalidDeclaration):
        twin_store.override_recurring(RENT, RecurringOverride())
    assert RENT not in twin_store.recurring_overrides


@pytest.mark.parametrize(
    "kwargs",
    [
        {"expected_amount": 0},
        {"expected_amount": -50},
        {"due_day": 0},
        {"due_day": 32},
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 81},
    ],
)
def test_an_invalid_value_cannot_even_be_expressed(kwargs):
    """Rejected when the change is built, so no caller can hand one to the store."""
    with pytest.raises(ValidationError):
        RecurringOverride(**kwargs)


def test_a_rejected_change_leaves_an_earlier_one_intact():
    twin_store.override_recurring(RENT, RecurringOverride(expected_amount=700))
    with pytest.raises(twin_store.InvalidDeclaration):
        twin_store.override_recurring(RENT, RecurringOverride())
    assert obligation(RENT).expected_amount == 700


# --- Persistence (PER-1, PER-8, PER-9) ------------------------------------------


def test_an_override_survives_a_restart():
    twin_store.override_recurring(RENT, RecurringOverride(expected_amount=700, active=False))
    before = twin_store.get_twin()

    restart()

    assert twin_store.get_twin() == before
    assert obligation(RENT).expected_amount == 700


def test_an_answers_file_without_overrides_still_loads():
    """A file written before this field existed must not be discarded."""
    twin_store.answers_path.parent.mkdir(parents=True, exist_ok=True)
    twin_store.answers_path.write_text(
        json.dumps({"declared_categories": {TRANSFER: "bill"}, "minimum_checking_balance": 300})
    )

    restart()

    assert twin_store.recurring_overrides == {}
    # The rest of the old file still took effect, so it was read and not skipped.
    assert obligation(TRANSFER).declared_category == "bill"
    assert obligation(RENT).active is True


def test_memory_only_keeps_working(monkeypatch):
    monkeypatch.setattr(twin_store, "answers_path", None)
    twin_store.override_recurring(RENT, RecurringOverride(active=False))
    assert obligation(RENT).active is False


def test_a_reset_forgets_overrides():
    twin_store.override_recurring(RENT, RecurringOverride(active=False))
    twin_store.reset()
    assert twin_store.recurring_overrides == {}


# --- User-declared recurring obligations (PER-1, PER-3, PER-4) -----------------


def recurring(name: str = "Wi-Fi") -> RecurringObligationCreate:
    return RecurringObligationCreate(name=name, amount=55, due_day=12, mandatory=True)


def test_a_declared_recurring_obligation_has_only_declared_facts():
    twin = twin_store.add_declared_recurring(recurring())

    added = next(o for o in twin.obligations if o.id == "rec_wi_fi")
    assert added.name == "Wi-Fi"
    assert added.expected_amount == 55
    assert added.due_day == 12
    assert added.mandatory is True
    assert added.provenance == "declared"
    assert added.confidence == 1.0
    assert added.category_candidates == []
    assert added.declared_category is None
    assert added.active is True


def test_a_declared_recurring_id_gets_a_numeric_suffix_on_collision():
    twin_store.add_declared_recurring(recurring())
    twin_store.override_recurring("rec_wi_fi", RecurringOverride(active=False))

    twin = twin_store.add_declared_recurring(recurring())

    assert {o.id for o in twin.obligations} >= {"rec_wi_fi", "rec_wi_fi_2"}


def test_a_vanished_obligations_override_keeps_its_id_reserved():
    twin_store.recurring_overrides["rec_wi_fi"] = RecurringOverride(active=False)

    twin = twin_store.add_declared_recurring(recurring())

    assert next(o for o in twin.obligations if o.id == "rec_wi_fi_2").active is True


def test_a_duplicate_active_declared_name_is_rejected_without_mutating():
    twin_store.add_declared_recurring(recurring())

    with pytest.raises(twin_store.InvalidDeclaration, match="already exists"):
        twin_store.add_declared_recurring(recurring("wi-fi"))

    assert [o.id for o in twin_store.declared_recurring] == ["rec_wi_fi"]


def test_a_declared_recurring_obligation_survives_a_restart():
    twin_store.add_declared_recurring(recurring())

    restart()

    assert next(o for o in twin_store.get_twin().obligations if o.id == "rec_wi_fi")


def test_an_old_answers_file_loads_with_no_declared_recurring_obligations():
    twin_store.answers_path.write_text(json.dumps({"declared_categories": {TRANSFER: "bill"}}))

    restart()

    assert twin_store.declared_recurring == []
    assert obligation(TRANSFER).declared_category == "bill"


def test_a_declared_recurring_obligation_can_be_edited_and_deleted():
    twin_store.add_declared_recurring(recurring())
    twin_store.override_recurring("rec_wi_fi", RecurringOverride(expected_amount=60))

    twin = twin_store.delete_declared_recurring("rec_wi_fi")

    assert all(o.id != "rec_wi_fi" for o in twin.obligations)
    assert "rec_wi_fi" not in twin_store.recurring_overrides


def test_a_detected_recurring_obligation_cannot_be_deleted():
    with pytest.raises(
        twin_store.DetectedObligationCannotBeDeleted,
        match="Detected payments can be paused, not deleted",
    ):
        twin_store.delete_declared_recurring(RENT)


def test_an_unknown_recurring_obligation_cannot_be_deleted():
    with pytest.raises(twin_store.UnknownObligation):
        twin_store.delete_declared_recurring("rec_missing")


def test_memory_only_keeps_a_declared_recurring_obligation(monkeypatch):
    monkeypatch.setattr(twin_store, "answers_path", None)

    twin_store.add_declared_recurring(recurring())

    assert next(o for o in twin_store.get_twin().obligations if o.id == "rec_wi_fi")


def test_reset_forgets_declared_recurring_obligations():
    twin_store.add_declared_recurring(recurring())

    twin_store.reset()

    assert twin_store.declared_recurring == []
