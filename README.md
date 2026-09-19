# TwinBank

A personal financial digital twin: *your bank knows what happened; TwinBank shows what happens next.*

See [`SPEC.md`](SPEC.md) for the product spec and [`CLAUDE.md`](CLAUDE.md) for team and Claude Code working rules.

## Status

**Phase 1 slice complete; mocks being replaced.** `GET /twin/alex` serves the hand-written twin in `backend/fixtures/`, plus whatever the user has since declared. `POST /simulate` runs a real 1,000-path Monte Carlo over that twin (`is_mock: false`); set `SIMULATION_SEED` to make the numbers repeat.

`POST /twin/build` detects the twin's observed half — income, obligations, variable spending — from a year of transactions in `backend/fixtures/transactions.json`, which stands in for Nessie until Phase 3. It returns the built twin rather than storing it, so `GET /twin/alex` and the demo are unaffected by it.

## Layout

```text
backend/
  src/backend/
    schemas.py      shared Pydantic contracts (source of truth)
    fixtures.py     loads JSON fixtures
    main.py         FastAPI app
  fixtures/
    twin.json       Alex's Financial Twin
    simulation.json $800 laptop baseline vs counterfactual
  tests/
frontend/           Next.js demo app
  app/page.tsx      the single demo screen (only component that fetches)
  components/       presentational panels
  lib/api.ts        getTwin / runSimulation + offline fixture fallback
  lib/types.ts      TypeScript mirror of schemas.py
  lib/mock/         copies of backend/fixtures/ for offline demo
```

## Backend

Requires [uv](https://docs.astral.sh/uv/). Python 3.12 is installed automatically by uv.

```bash
cd backend
uv sync
uv run uvicorn backend.main:app --reload --port 8000
uv run pytest
```

Endpoints:

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/health` | `{"status": "ok"}` |
| GET | `/twin/{user_id}` | `FinancialTwin` (only `alex` exists) |
| POST | `/twin/build` | `FinancialTwin` built from transactions, for a `TwinBuildRequest` |
| PUT | `/twin/{user_id}/minimum-balance` | `FinancialTwin` with the user's low-balance line set |
| POST | `/clarifications/respond` | `FinancialTwin` with the user's category answer applied |
| POST | `/simulate` | `SimulationResponse` for a `SimulationRequest` |

Interactive docs: http://localhost:8000/docs

## Frontend

Requires Node 22.

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
npm run lint
npm run typecheck
npm run build
```

It calls the backend at `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`) and falls
back to the fixtures in `frontend/lib/mock/` if the backend is unreachable, so the demo
renders on its own.

## Configuration

Copy `.env.example` to `.env`. The defaults run the demo with mocks and no credentials.

## Workstreams

| Workstream | Owns | Starts from |
| --- | --- | --- |
| 1. Data / Financial Twin | Nessie, normalization, recurrence detection, forecasting, Databricks | Produce a `FinancialTwin` matching `backend/fixtures/twin.json` |
| 2. Simulation / Intelligence | Simulator, Monte Carlo, goal compiler, explanations, optimization | Turn `SimulationRequest` + `FinancialTwin` into a `SimulationResponse` |
| 3. Frontend / Integration | Next.js app, twin view, scenario UI, charts | Consume `/twin/alex` and `/simulate` |

Changes to `backend/src/backend/schemas.py` affect everyone: keep them small, backwards-compatible, and in their own PR.
