# TwinBank

A personal financial digital twin: *your bank knows what happened; TwinBank shows what happens next.*

See [`SPEC.md`](SPEC.md) for the product spec, [`docs/demo-walkthrough.md`](docs/demo-walkthrough.md)
for the repeatable Alex presentation, and [`CLAUDE.md`](CLAUDE.md) for team and Claude Code working rules.

## Status

**Phase 3: real data behind a switch.** `GET /twin/alex` serves the hand-written twin in `backend/fixtures/`, plus whatever the user has since declared. `POST /simulate` runs a real 1,000-path Monte Carlo over that twin (`is_mock: false`); set `SIMULATION_SEED` to make the numbers repeat.

The frontend is a six-page app reached from the top-left menu: **Overview**, **Plans & Assistant** (a chat that drafts goals, plus the Goals & Limits panel), **Obligations**, **Purchase Simulator** (baseline vs counterfactual, alternatives, and Proceed / Sacrifice / Compromise actions), **Balance Trajectory** and **Forecast & Data**. [`docs/demo-walkthrough.md`](docs/demo-walkthrough.md) walks through all six.

`POST /twin/build` detects the twin's observed half — income, obligations, variable spending — from a year of transactions, and returns it rather than storing it.

It is the one endpoint the frontend does not call, and that is deliberate. Because a build changes nothing, a "Rebuild" control could only show a twin the app is not using, or imply a refresh that did not happen — which [`frontend/SPEC.md`](frontend/SPEC.md) §3.5 rules out until the backend exposes an authenticated, persistent operation. It exists to exercise the ingest pipeline, to log a build to MLflow, and as the seam the Nessie and Databricks paths build through. Giving it a UI needs somewhere for the result to go and something deciding who may ask for it.

With `USE_MOCKS=false` and a `NESSIE_API_KEY`, those transactions and the account balances come from Capital One Nessie instead of the fixtures. Mocks are the default, so a fresh clone runs the whole demo with no credentials, and if Nessie is unreachable the fixture is served with a warning rather than the demo breaking.

## Layout

```text
backend/            see backend/README.md
  src/backend/
    schemas.py      shared Pydantic contracts (source of truth)
    main.py         FastAPI app and routes
    twin_store.py   the twin plus the user's declared answers
    twin_source.py  fixture, Nessie or Databricks as the twin's observed half
    ingest/         normalize transactions, detect recurrence, build the twin
    simulation/     Monte Carlo engine, impact, alternatives, explanations
    nessie/         Capital One Nessie client and seed script
    assistant.py    the chat: reads a message into drafts and questions
  fixtures/         Alex's twin, transactions and simulation fixture
  tests/
frontend/           Next.js app, see frontend/README.md
  app/              one route per page (/, /plans, /obligations, /simulate,
                    /trajectory, /insights)
  components/       panels and charts
  lib/api.ts        the only module that talks to the backend, with offline fallback
  lib/types.ts      TypeScript mirror of schemas.py
  lib/mock/         copies of backend/fixtures/ for offline demo
docs/               demo walkthrough
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
| GET | `/twin/{user_id}/overview` | `OverviewPayload`: the Overview page's tiles, accounts, spending and upcoming activity |
| GET | `/twin/{user_id}/forecast` | `ForecastPayload`: the baseline forecast, seasonal trends and data provenance |
| GET | `/twin/{user_id}/obligations` | `ObligationsPayload`: recurring and one-time obligations |
| POST, PUT, DELETE | `/twin/{user_id}/obligations/recurring[/{obligation_id}]` | `FinancialTwin` after adding, editing (name, amount, due day, paused) or deleting a declared recurring obligation. Detected ones can be edited but not deleted (409) |
| POST, PUT, DELETE | `/twin/{user_id}/obligations/one-time[/{obligation_id}]` | `FinancialTwin` after adding, editing or deleting a one-time obligation |
| POST | `/twin/build` | `FinancialTwin` built from transactions, for a `TwinBuildRequest` |
| PUT | `/twin/{user_id}/minimum-balance` | `FinancialTwin` with the user's low-balance line set |
| PUT | `/twin/{user_id}/reserve` | `FinancialTwin` with the emergency reserve set (0 removes it) |
| POST | `/clarifications/respond` | `FinancialTwin` with the user's category answer applied |
| POST | `/simulate` | `SimulationResponse` for a `SimulationRequest` |
| GET | `/explain/{simulation_id}` | A recent `SimulationResponse` again, explanation included (404 once expired) |
| POST | `/optimize` | `OptimizationResponse`: alternatives to a purchase, ranked, for an `OptimizationRequest` |
| POST | `/goals/compile` | `GoalCompileResponse`: draft goals, constraints and clarification questions from a `GoalCompileRequest` (saves nothing) |
| PUT | `/twin/{user_id}/goals` | `FinancialTwin` after saving the confirmed goals and emergency reserve (`DeclaredGoalsRequest`) |
| PATCH, DELETE | `/twin/{user_id}/goals/{goal_id}` | `FinancialTwin` after a partial goal edit (`GoalChanges`) or a delete |
| POST | `/twin/{user_id}/goals/{goal_id}/earliest-date` | `EarliestDateResponse`: the first deadline at which a purchase stops costing that goal |
| POST | `/twin/{user_id}/purchases/commit` | `CommitPurchaseResponse`: the purchase added to the plan as a one-off obligation, optionally moving goal deadlines. Moves no money |
| GET | `/assistant/opening/{user_id}` | `AssistantOpening`: up to two questions about payments TwinBank cannot categorise |
| POST | `/assistant/message` | `AssistantMessageResponse`: one chat message read into draft cards and questions. Changes nothing |
| POST | `/assistant/proposals/{proposal_id}/decision` | `ProposalDecisionResponse`: accepts or rejects one draft card. Accepting is the only chat action that changes the twin |

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

It calls the backend at `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`). If the backend
is unreachable, Overview and Forecast & Data render from the fixtures in `frontend/lib/mock/`
under a **Backend offline** banner, and every control that writes is disabled. Simulation,
optimization and the Assistant need the backend and say so rather than showing a saved result.

## Configuration

Copy `.env.example` to `.env`. The defaults run the demo with mocks and no credentials.

The user's answers (declared categories, minimum balance, goals, reserve and obligation edits) are saved to `backend/.data/answers.json` and survive a backend restart. Delete that file and restart to demo from a clean slate, or set `TWIN_ANSWERS_PATH=` (empty) to ignore it and keep answers in memory only.

`SIMULATION_SEED` fixes the Monte Carlo seed, and `CORS_ORIGINS` (default `http://localhost:3000`) lists the frontend origins the backend accepts.

### Drafting goals with Gemini (optional)

`POST /goals/compile` has Gemini draft goals from the text whenever `GEMINI_API_KEY` is set, and uses the rule-based compiler when it is not, so no key is needed to run the demo. Set the key in `.env` and start the backend with `uv run --env-file ../.env uvicorn backend.main:app --reload --port 8000` (the backend does not read `.env` by itself):

```sh
GEMINI_API_KEY=...
GOAL_COMPILER=llm                  # the default; set rules to force the rule-based compiler
LLM_MODEL=gemini-3-flash-preview   # optional; this is the default
```

The LLM only extracts draft items. Deterministic code checks each one: the fragment must appear in the text, the amount must appear in the fragment, and the deadline goes through the same checks as the rules compiler. Anything that fails a check becomes a clarification question. If the key is missing or the call fails or takes over 6 seconds, the endpoint falls back to the rules compiler. The response's `compiler` field says which one ran.

### Using real Nessie data (optional)

Get a key at [api.nessieisreal.com](http://api.nessieisreal.com), then put Alex in the sandbox — it ships empty, so there is nothing to read until you do:

```bash
cd backend
NESSIE_API_KEY=... uv run python -m backend.nessie.seed
```

It prints the account ids it created. Put those and the key in `.env`, set `USE_MOCKS=false`, and restart the backend; `GET /twin/alex` is then built from Nessie. Note the base URL is `https://` — the `http://` host in Nessie's own docs refuses connections.

### Building the twin on Databricks (optional)

`backend/databricks.yml` is a Databricks Asset Bundle that runs the same build as `POST /twin/build` (`backend.build_job`) as a serverless job and writes the twin to a Unity Catalog volume. To serve that twin, set `USE_MOCKS=false`, `DATABRICKS_TWIN_PATH`, `DATABRICKS_HOST` and `DATABRICKS_TOKEN`; it takes precedence over Nessie. Setup steps are in the header of `databricks.yml`. Nothing else imports the job, and without all three variables the fixtures stay in charge.

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
