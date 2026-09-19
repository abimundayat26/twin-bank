# TwinBank

A personal financial digital twin: *your bank knows what happened; TwinBank shows what happens next.*

See [`SPEC.md`](SPEC.md) for the product spec and [`CLAUDE.md`](CLAUDE.md) for team and Claude Code working rules.

## Status

**Phase 1: mocked vertical slice.** `GET /twin/alex` and `POST /simulate` return fixture data from `backend/fixtures/`. `/simulate` validates the request but always returns the $800 laptop result (`is_mock: true`).

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
| POST | `/simulate` | `SimulationResponse` for a `SimulationRequest` |
| POST | `/optimize` | `OptimizationResponse`: alternatives to a purchase, ranked, for an `OptimizationRequest` |

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
