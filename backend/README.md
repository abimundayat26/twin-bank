# TwinBank backend

FastAPI service that serves Alex's Financial Twin, runs the Monte Carlo simulation, and drafts goals. The
endpoint list, configuration and optional integrations (Nessie, Databricks, MLflow, Claude) are in the
[root README](../README.md). This file is a map of the code.

```bash
uv sync
uv run uvicorn backend.main:app --reload --port 8000
uv run pytest
```

Tests make no network or model calls; `tests/conftest.py` removes any model key.

## Layout

| Path | What it does |
| --- | --- |
| `src/backend/schemas.py` | Pydantic contracts shared with the frontend. The source of truth; change it in its own PR |
| `src/backend/main.py` | Routes only. Business logic lives in the modules below |
| `src/backend/twin_store.py` | The twin plus the user's declared answers (categories, goals, reserve, obligation edits), saved to `.data/answers.json` |
| `src/backend/twin_source.py` | Chooses where the observed twin comes from: fixture, Nessie or Databricks. Falls back to the fixture on an outage |
| `src/backend/fixtures.py` | Loads `fixtures/*.json` |
| `src/backend/ingest/` | Normalizes transactions, detects recurring bills and income, builds the twin's observed half |
| `src/backend/forecast.py`, `forecast_view.py` | Seasonal spending forecast, and the payload for Forecast & Data |
| `src/backend/simulation/` | Deterministic engine, Monte Carlo, impact level, ranked alternatives (`optimize.py`), earliest goal date, explanations |
| `src/backend/overview.py`, `obligations.py` | Payloads for the Overview and Obligations pages |
| `src/backend/goal_compiler.py`, `llm_goal_compiler.py` | Rule-based goal compiler, and the optional Claude extractor that its output is checked against |
| `src/backend/assistant.py`, `assistant_store.py`, `intent_router.py` | The chat: reads a message into draft cards and questions; the store holds conversations and proposals in memory |
| `src/backend/nessie/` | Capital One Nessie client, config, readback check and sandbox seed script |
| `src/backend/databricks_twin.py`, `build_job.py`, `databricks.yml` | Reads back a twin built by the Databricks job, and the job itself |
| `src/backend/tracking.py` | Optional MLflow logging of twin builds |
| `src/backend/simulation_store.py` | Recent simulations, served again by `/explain/{simulation_id}` |
| `src/backend/regenerate_*_fixture.py`, `sync_frontend_mocks.py` | Regenerate `fixtures/` and copy them to `frontend/lib/mock/` |
| `fixtures/` | Alex's twin, transactions and simulation fixture, plus Nessie samples |

## Fixtures

`fixtures/twin_seed.json` is the hand-written input. Everything else in `fixtures/` is generated from it, in
this order, and `frontend/lib/mock/` is a copy of the result:

```bash
uv run python -m backend.ingest.generate_transactions   # only if the seed changed
uv run python -m backend.regenerate_twin_fixture
uv run python -m backend.regenerate_simulation_fixture
uv run python -m backend.sync_frontend_mocks
```

`tests/test_twin_fixture.py`, `tests/test_simulation_fixture.py` and `tests/test_frontend_mocks.py` fail if a
generated file drifts.
