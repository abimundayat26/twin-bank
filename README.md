# TwinBank

A personal financial digital twin: *your bank knows what happened; TwinBank shows what happens next.*

See [`SPEC.md`](SPEC.md) for the product spec and [`CLAUDE.md`](CLAUDE.md) for team and Claude Code working rules.

## Status

**Phase 3: real data behind a switch.** `GET /twin/alex` serves the hand-written twin in `backend/fixtures/`, plus whatever the user has since declared. `POST /simulate` runs a real 1,000-path Monte Carlo over that twin (`is_mock: false`); set `SIMULATION_SEED` to make the numbers repeat.

`POST /twin/build` detects the twin's observed half — income, obligations, variable spending — from a year of transactions, and returns it rather than storing it.

With `USE_MOCKS=false` and a `NESSIE_API_KEY`, those transactions and the account balances come from Capital One Nessie instead of the fixtures. Mocks are the default, so a fresh clone runs the whole demo with no credentials, and if Nessie is unreachable the fixture is served with a warning rather than the demo breaking.

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
| POST | `/optimize` | `OptimizationResponse`: alternatives to a purchase, ranked, for an `OptimizationRequest` |
| POST | `/goals/compile` | `GoalCompileResponse`: draft goals, constraints and clarification questions from a `GoalCompileRequest` (saves nothing) |
| PUT | `/twin/{user_id}/goals` | `FinancialTwin` after saving the confirmed goals and emergency reserve (`DeclaredGoalsRequest`) |

Interactive docs: http://localhost:8000/docs

## Frontend

Requires Node 22. On WSL, install Node inside Linux (for example with nvm): the Windows
`npm` under `/mnt/c` cannot run scripts from a WSL path.

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
npm run lint
npm run typecheck  # generates Next's route types first, so it works on a fresh clone
npm test           # Vitest unit tests (lib/*.test.ts)
npm run build
```

It calls the backend at `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`) and falls
back to the fixtures in `frontend/lib/mock/` if the backend is unreachable, so the demo
renders on its own.

## Configuration

Copy `.env.example` to `.env`. The defaults run the demo with mocks and no credentials.

The user's answers (declared categories, minimum balance, goals and reserve) are saved to `backend/.data/answers.json` and survive a backend restart. Delete that file and restart to demo from a clean slate.

### Drafting goals with Claude (optional)

`POST /goals/compile` uses the rule-based compiler by default, so no key is needed. To have Claude draft goals from the text instead, set these in `.env`:

```sh
GOAL_COMPILER=llm
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-5   # optional; this is the default
```

The LLM only extracts draft items. Deterministic code checks each one: the fragment must appear in the text, the amount must appear in the fragment, and the deadline goes through the same checks as the rules compiler. Anything that fails a check becomes a clarification question. If the key is missing or the call fails or takes over 6 seconds, the endpoint falls back to the rules compiler. The response's `compiler` field says which one ran.

### Using real Nessie data (optional)

Get a key at [api.nessieisreal.com](http://api.nessieisreal.com), then put Alex in the sandbox — it ships empty, so there is nothing to read until you do:

```bash
cd backend
NESSIE_API_KEY=... uv run python -m backend.nessie.seed
```

It prints the account ids it created. Put those and the key in `.env`, set `USE_MOCKS=false`, and restart the backend; `GET /twin/alex` is then built from Nessie. Note the base URL is `https://` — the `http://` host in Nessie's own docs refuses connections.

### Tracking twin builds with MLflow (optional)

Every time a twin is built from transactions (`POST /twin/build`, or a Nessie build when `USE_MOCKS=false`), the backend can record it as an MLflow run: the forecast method, its window and half-life as params, and each spending category's `mean_14d`, `std_dev_14d` and seasonal max/min as metrics. Balances and goals are never recorded. Serving the hand-written fixture twin is not a build, so it records nothing.

It is off by default. To record runs locally:

```bash
cd backend
TRACK_TWIN_BUILDS=true uv run uvicorn backend.main:app --reload --port 8000
curl -X POST localhost:8000/twin/build -H "Content-Type: application/json" -d '{"user_id": "alex"}'
```

Runs go to `backend/mlflow.db` (git-ignored), in the `twin-builds` experiment. The backend installs only the lightweight MLflow client, so view them with the full MLflow UI through `uvx`, which keeps it out of the project's dependencies:

```bash
cd backend
uvx --from mlflow==3.16.1 mlflow ui --backend-store-uri sqlite:///mlflow.db   # http://localhost:5000
```

To log to Databricks instead, set these in `.env` with your own workspace host and token, and start the backend with `uv run --env-file ../.env uvicorn ...`:

```sh
TRACK_TWIN_BUILDS=true
MLFLOW_TRACKING_URI=databricks
MLFLOW_EXPERIMENT_NAME=/Shared/twin-builds   # Databricks needs a workspace path
DATABRICKS_HOST=https://<your-workspace>.cloud.databricks.com
DATABRICKS_TOKEN=...
```

If tracking fails (no credentials, server unreachable), the backend logs a warning and the build carries on.

## Workstreams

| Workstream | Owns | Starts from |
| --- | --- | --- |
| 1. Data / Financial Twin | Nessie, normalization, recurrence detection, forecasting, Databricks | Produce a `FinancialTwin` matching `backend/fixtures/twin.json` |
| 2. Simulation / Intelligence | Simulator, Monte Carlo, goal compiler, explanations, optimization | Turn `SimulationRequest` + `FinancialTwin` into a `SimulationResponse` |
| 3. Frontend / Integration | Next.js app, twin view, scenario UI, charts | Consume `/twin/alex` and `/simulate` |

Changes to `backend/src/backend/schemas.py` affect everyone: keep them small, backwards-compatible, and in their own PR.
