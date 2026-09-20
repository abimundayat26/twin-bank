"""Rebuilding backend/fixtures/twin.json from the mock feed.

The seed and the served twin are two files with two jobs: `twin_seed.json` is
the hand-written structure the generator plants in the feed, and `twin.json` is
what a detector recovers from it. These tests cover the rebuild itself — that it
reads the seed, dates itself from the feed, and carries declared data through
untouched.
"""

import json
from datetime import date, timedelta

from backend.fixtures import FIXTURES_DIR, load_raw_transactions, load_seed_twin, load_twin
from backend.ingest import normalize_all
from backend.ingest.recurrence import BLOCK_DAYS, fortnight_blocks
from backend.regenerate_twin_fixture import build


def test_fixture_is_the_generator_output():
    """Fails when the detector moves the numbers but the fixture is not regenerated.

    Fix by running: uv run python -m backend.regenerate_twin_fixture
    """
    committed = json.loads((FIXTURES_DIR / "twin.json").read_text())
    assert committed == build().model_dump(mode="json")


def test_the_served_twin_records_how_it_was_estimated():
    """The demo twin can say where its figures came from, which is what /insights shows."""
    forecast = load_twin().forecast
    assert forecast is not None
    assert forecast.method == "seasonal_ewma"
    assert forecast.as_of.isoformat() == "2026-09-18"
    # The fitted window, not the whole feed. The feed opens on 2025-09-20, but
    # 363 days leaves 13 over, so the oldest 14 days fall outside every block.
    assert forecast.window_start.isoformat() == "2025-10-04"
    assert forecast.observed_fortnights == 25


def test_the_seed_is_loadable_and_is_alex():
    seed = load_seed_twin()
    assert seed.user_id == "alex"
    assert seed.accounts, "the generator needs accounts to post transactions to"


def test_the_rebuild_is_dated_from_the_feed_not_the_seed():
    """A twin must not describe a day it has not observed.

    Fortnight blocks are counted backwards from `as_of`, so letting the seed's
    own `as_of` through would push the newest block one day past the end of the
    feed -- thirteen days of spending counted as fourteen, in the block the
    recency weighting leans on hardest.
    """
    last_day = max(t.date for t in normalize_all(load_raw_transactions()))
    assert build().as_of == last_day
    assert build().as_of < load_seed_twin().as_of


def test_a_later_as_of_would_run_the_newest_block_past_the_feed():
    """The reason for the line above, as an assertion rather than a comment.

    Blocks are counted back from `as_of`. One day later is not a new block at
    the old end of the window; it is the same count of blocks shifted forward,
    with the newest one now ending on a day the feed does not reach.
    """
    transactions = normalize_all(load_raw_transactions())
    last_day = max(t.date for t in transactions)
    window_start = min(t.date for t in transactions)

    honest = fortnight_blocks(window_start, last_day)
    overshot = fortnight_blocks(window_start, last_day + timedelta(days=1))

    assert honest[-1][1] == last_day
    assert overshot[-1][1] > last_day
    assert len([d for d in date_range(*overshot[-1]) if d <= last_day]) == BLOCK_DAYS - 1


def date_range(start: date, end: date) -> list[date]:
    return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]


def test_declared_data_is_carried_from_the_seed_never_detected():
    """SPEC section 2: no transaction history can produce a goal or a reserve."""
    seed, built = load_seed_twin(), build()
    assert built.goals == seed.goals
    assert built.constraints == seed.constraints
    assert built.user_id == seed.user_id
    assert built.display_name == seed.display_name


def test_balances_are_carried_because_a_statement_cannot_produce_them():
    assert build().accounts == load_seed_twin().accounts


def test_the_rebuild_records_how_it_estimated():
    """The point of the split: the served twin can say where its figures came from."""
    forecast = build().forecast
    assert forecast is not None
    assert forecast.as_of == build().as_of
    assert forecast.observed_fortnights > 0


def test_the_rebuild_is_deterministic():
    """Same feed, same bytes, so a regenerated fixture diffs cleanly or not at all."""
    assert build() == build()
