# TwinBank

> Built at **HackVT 2026** by **Team TwinBank** — a personal financial digital twin:
> *your bank knows what happened; TwinBank shows what happens next.*

## What it does

TwinBank combines observed banking activity, user-declared financial goals, and constraints
with forecasting, simulation, and optimization — so you can see how today's money decisions
affect your future balance.

- **Purchase Simulator** — enter a purchase and compare baseline vs. counterfactual outcomes, with ranked alternatives and Proceed / Sacrifice / Compromise actions
- **Balance Trajectory** — 1,000-path Monte Carlo projection with confidence bands and stated assumptions
- **Plans & Assistant** — a chat that drafts goals, constraints, and obligations from plain language; nothing touches the plan until the user accepts a draft
- **Obligations** — recurring and one-time obligations that feed the simulator and optimizer
- **Forecast & Data** — seasonal spending profiles and forecast provenance

## Tech stack

| Layer | Tech |
| --- | --- |
| Backend | Python 3.12, FastAPI, Pydantic, uv |
| Frontend | Next.js (App Router), React 19, TypeScript, Tailwind |
| Simulation | 1,000-path Monte Carlo, deterministic forecasting with seasonal profiles |
| Data | Capital One Nessie API (live) or built-in fixtures (default — no keys needed); Databricks Asset Bundle and MLflow tracking behind flags |
| AI | Gemini goal compiler with deterministic validation and a rule-based fallback |

## Try the demo

No credentials needed — a fresh clone runs the whole demo on fixtures.

```bash
# backend
cd backend
uv sync
uv run uvicorn backend.main:app --reload --port 8000

# frontend (new terminal)
cd frontend
npm install
npm run dev        # http://localhost:3000
```

[`docs/demo-walkthrough.md`](docs/demo-walkthrough.md) is the scripted six-page walkthrough;
[`DEMO_CHECKLIST.md`](DEMO_CHECKLIST.md) is the pre-demo checklist.

## Status

Built through Phase 6 of [`SPEC.md`](SPEC.md): mocked end-to-end demo, deterministic
calculations, live Nessie data, Monte Carlo forecasting, goal compilation and optimization,
then Databricks/MLflow behind flags. Demo polish (Phase 7) is in progress.

## Docs

- [`SPEC.md`](SPEC.md) — product spec and implementation strategy
- [`docs/demo-walkthrough.md`](docs/demo-walkthrough.md) — scripted demo walkthrough
- [`backend/README.md`](backend/README.md), [`frontend/README.md`](frontend/README.md) — per-app setup and internals

## Backend

Requires [uv](https://docs.astral.sh/uv/). Python 3.12 is installed automatically by uv.

```bash
cd backend
uv sync
uv run uvicorn backend.main:app --reload --port 8000
uv run pytest
```

Interactive API docs: http://localhost:8000/docs

## Frontend

Requires Node 22.

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
npm run lint
npm run typecheck
npm test           # Vitest unit tests
npm run build
```

It calls the backend at `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`). If the backend
is unreachable, Overview and Forecast & Data render from the fixtures in `frontend/lib/mock/`
under a **Backend offline** banner, and every control that writes is disabled.

## Configuration

Copy `.env.example` to `.env`. The defaults run the demo with mocks and no credentials.

- `SIMULATION_SEED` fixes the Monte Carlo seed so demo numbers repeat.
- Declared answers (categories, minimum balance, goals, reserve, obligation edits) are saved to `backend/.data/answers.json` and survive a backend restart; delete it for a clean slate.

### Drafting goals with Gemini (optional)

`POST /goals/compile` has Gemini draft goals from the text whenever `GEMINI_API_KEY` is set,
and uses the rule-based compiler when it is not — no key is needed to run the demo. The LLM
only extracts draft items; deterministic code validates each one, and anything that fails a
check becomes a clarification question.

### Using real Nessie data (optional)

Get a key at [api.nessieisreal.com](http://api.nessieisreal.com), seed the sandbox, then set
`USE_MOCKS=false` with your key in `.env` and restart the backend.

### Building the twin on Databricks (optional)

`backend/databricks.yml` is a Databricks Asset Bundle that runs the same twin build as a
serverless job. Set `USE_MOCKS=false`, `DATABRICKS_TWIN_PATH`, `DATABRICKS_HOST`, and
`DATABRICKS_TOKEN` to serve that twin. `TRACK_TWIN_BUILDS=true` records each build as an
MLflow run.

## Team

Team TwinBank at HackVT 2026 — [contributors](https://github.com/abimundayat26/twin-bank/graphs/contributors).

## License

MIT — see [LICENSE](LICENSE).
