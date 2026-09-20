# TwinBank Project Specification

## 1. Project Summary

TwinBank is a personal financial digital twin.

It combines:

* observed banking activity,
* user-declared financial goals,
* user-declared constraints,
* forecasting,
* simulation,
* and optimization

to show how financial decisions made today may affect the user's future financial state.

Core idea:

> Your bank knows what happened. TwinBank shows what happens next.

TwinBank is not intended to be:

* another budgeting dashboard,
* a generic financial chatbot,
* or an AI system that guesses the user's personal intentions from transaction history.

---

## 2. Core Design Principle

The system must distinguish between:

### Machine-observed information

Examples:

* account balances,
* paycheck cadence,
* recurring bills,
* recurring transfers,
* spending patterns,
* spending variance,
* income variance.

### User-declared information

Examples:

* "This transfer is savings."
* "I want $2,000 for summer housing by May."
* "Do not let my emergency reserve fall below $1,500."
* "This expense is mandatory."

The system must never claim that it can infer a specific personal goal purely from transaction history.

---

## 3. Main Demo Persona

The primary demo user is Alex, a college student.

Alex has:

* checking account,
* savings account,
* part-time income,
* rent,
* utilities,
* groceries,
* subscriptions,
* discretionary spending.

Alex declares:

> I need $1,600 for summer housing by May and want to keep at least $1,500 for emergencies.

Alex later asks:

> What happens if I buy an $800 laptop?

TwinBank compares:

### Baseline

The financial future without the purchase.

### Counterfactual

The financial future with the $800 purchase.

The comparison should include:

* ending balance,
* probability of low balance,
* probability of touching the emergency reserve,
* effect on the housing goal,
* ability to cover upcoming obligations.

TwinBank should not simply say whether Alex "can" or "cannot" afford the laptop.

It should expose the tradeoffs and let the user decide.

---

## 4. Core MVP

The MVP must contain:

1. Capital One Nessie integration.
2. Financial transaction normalization.
3. Financial Twin representation.
4. Detection of basic recurring financial structure.
5. User goal compiler.
6. Financial forecasting.
7. Monte Carlo future simulation.
8. Counterfactual purchase simulation.
9. Explanation of important simulation results.
10. Basic optimization for alternative actions.
11. Coherent frontend demo.

This list names components, not build order. Build order is defined by the phases in Section 5.

---

## 5. Implementation Strategy

We are using Plan A: demo-first vertical slice.

Implementation priority:

### Phase 1

Build a complete mocked end-to-end demo.

The user should be able to:

1. load Alex,
2. see the Financial Twin,
3. enter an $800 laptop purchase,
4. click Simulate,
5. compare baseline and counterfactual results,
6. see an explanation.

The data and calculations may initially be mocked.

### Phase 2

Replace mocked simulation with real deterministic financial calculations.

### Phase 3

Replace mocked financial data with Nessie data.

### Phase 4

Add probabilistic forecasting and Monte Carlo simulation.

### Phase 5

Add natural-language goal compilation and optimization.

### Phase 6

Move appropriate data and ML processing into Databricks and add MLflow tracking.

### Phase 7

Polish the demo.

### Phase 8

Only if the core product is stable, attempt stretch features such as ANS.

At every phase, preserve a functioning end-to-end demo.

Phases describe what the demo on `main` does. Workstreams (Section 10) may build later-phase components in parallel, as long as each component stays behind a mock until it is ready.

### Current Status (2026-09-20)

| Phase | State |
| --- | --- |
| 1. Mocked end-to-end demo | Done |
| 2. Deterministic calculations | Done |
| 3. Nessie data | Done. Alex is seeded in the live sandbox, and `USE_MOCKS=false` plus a key builds the twin from Nessie. Read back from the live sandbox on 2026-09-19, Alex is recognisable (`backend.nessie.readback`, #65); Nessie stores amounts in whole dollars (#68). The demo stays on fixtures by default. |
| 4. Monte Carlo | Done. The Balance Trajectory page shows the projection behind the last simulation with its bands and assumptions, and the Insights page shows the forecast. Alex's demo twin now carries its fitted seasonal profiles and forecast metadata (`backend/fixtures/twin.json`), so the whole demo runs on the forecast. |
| 5. Goal compilation and optimization | Done. The Plans & Assistant page has a Goals & Limits panel (goals, emergency reserve, minimum balance) and an Assistant chat that drafts goals, constraints, one-time obligations and answers about detected recurring bills; nothing reaches the twin until the user accepts a draft (`/assistant/*`). The Obligations page and one-time obligations feed the simulator and optimizer. The Purchase Simulator shows an impact level with reasons, ranked alternatives, a commit action and the earliest date a goal can still be met. `GOAL_COMPILER` defaults to `llm`, which only takes effect where `ANTHROPIC_API_KEY` is set; with no key, with `GOAL_COMPILER=rules`, or when a call fails, the rule-based compiler runs. |
| 6. Databricks and MLflow | Built behind flags, off by default. `backend/databricks.yml` deploys `backend.build_job`, which builds a twin from a transactions file; `DATABRICKS_TWIN_PATH` with `USE_MOCKS=false`, `DATABRICKS_HOST` and `DATABRICKS_TOKEN` serves that twin; `TRACK_TWIN_BUILDS=true` records each twin build as an MLflow run. The default demo uses none of it, and this update did not run it against a live workspace. |
| 7. Demo polish | In progress. A minimalist multi-page UI (Overview, Plans & Assistant, Obligations, Purchase Simulator, Balance Trajectory, Insights), a scripted walkthrough (`docs/demo-walkthrough.md`) and a pre-demo checklist (`DEMO_CHECKLIST.md`) are in. |

Main gaps, in priority order:

1. Databricks and MLflow are built but not part of the default demo, and have not been run against a live workspace since they were built.
2. Explanations are template-based (Section 13).
3. `POST /twin/build` has no UI, on purpose: it returns a twin without storing it, so a "Rebuild" control would have nothing to show (see `README.md`).

---

## 6. Architecture

Primary architecture:

Capital One Nessie
→ raw banking events
→ Databricks
→ normalized financial data
→ financial structure / forecasts
→ Financial Twin
→ simulation / optimization
→ FastAPI
→ Next.js frontend

The LLM is only used for:

* interpreting natural-language goals,
* asking clarifying questions,
* generating explanations from structured outputs,
* optional agent orchestration.

The LLM must not be used for:

* balance calculations,
* simulation calculations,
* enforcement of financial constraints,
* inventing financial facts,
* inventing user goals.

Financial calculations must be handled by deterministic or statistical code.

---

## 7. Planned Technology Stack

Frontend:

* Next.js
* React
* TypeScript
* React Flow

Backend:

* Python
* FastAPI
* Pydantic
* uv
* pytest

Data / ML:

* Databricks
* MLflow
* pandas
* NumPy
* scikit-learn

Banking:

* Capital One Nessie API

Optimization:

* simple deterministic search first,
* potentially OR-Tools later.

LLM:

* Anthropic (Claude Sonnet 5, `claude-sonnet-5`; see Section 13).

This list is the plan. In the repo today:

* Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS, Vitest. React Flow is not a dependency, and there is no Financial Intent Graph.
* Backend: FastAPI, Pydantic, httpx, the Anthropic SDK, `mlflow-skinny`, pytest. pandas, NumPy and scikit-learn are not dependencies; the forecast and the Monte Carlo simulation are plain Python.

---

## 8. Core Financial Twin

The Financial Twin should eventually contain approximately:

* user ID,
* accounts,
* current balance,
* expected income streams,
* recurring obligations,
* variable spending distributions,
* goals,
* financial constraints,
* forecast metadata.

Example concepts:

```json
{
  "user_id": "alex",
  "current_balance": 2840,
  "income": [
    {
      "source": "paycheck",
      "expected_amount": 1490,
      "interval_days": 14,
      "uncertainty": 60
    }
  ],
  "obligations": [
    {
      "name": "rent",
      "expected_amount": 975,
      "due_day": 1,
      "confidence": 0.99
    }
  ],
  "variable_spending": {
    "groceries": {
      "mean_14d": 175,
      "std_dev": 40
    },
    "discretionary": {
      "mean_14d": 120,
      "std_dev": 65
    }
  },
  "goals": [
    {
      "name": "summer_housing",
      "target": 2000,
      "deadline": "2027-05-01"
    }
  ],
  "constraints": {
    "minimum_emergency_reserve": 1500
  }
}
```

This is conceptual and may evolve. It lists `accounts` but the example does not show them yet.

Once `backend/src/backend/schemas.py` exists, it is the authoritative definition of the Financial Twin and other shared contracts. This example is illustrative only.

Conventions for all shared data:

* money is in USD dollars, as numbers,
* dates are ISO 8601 (`YYYY-MM-DD`),
* probabilities are between 0 and 1.

---

## 9. Core API

API surface (from `backend/src/backend/main.py`):

```text
GET    /health

GET    /twin/{user_id}
GET    /twin/{user_id}/overview
GET    /twin/{user_id}/forecast
GET    /twin/{user_id}/obligations
POST   /twin/build

PUT    /twin/{user_id}/minimum-balance
POST   /clarifications/respond
PUT    /twin/{user_id}/goals
PATCH  /twin/{user_id}/goals/{goal_id}
DELETE /twin/{user_id}/goals/{goal_id}
PUT    /twin/{user_id}/reserve

POST   /twin/{user_id}/obligations/recurring
PUT    /twin/{user_id}/obligations/recurring/{obligation_id}
DELETE /twin/{user_id}/obligations/recurring/{obligation_id}
POST   /twin/{user_id}/obligations/one-time
PUT    /twin/{user_id}/obligations/one-time/{obligation_id}
DELETE /twin/{user_id}/obligations/one-time/{obligation_id}

POST   /goals/compile
POST   /simulate
GET    /explain/{simulation_id}
POST   /optimize
POST   /twin/{user_id}/goals/{goal_id}/earliest-date
POST   /twin/{user_id}/purchases/commit

GET    /assistant/opening/{user_id}
POST   /assistant/message
POST   /assistant/proposals/{proposal_id}/decision
```

Build only what the current phase requires.

All of these endpoints exist, and the frontend calls all of them except `GET /health` and `POST /twin/build`. Wire existing endpoints into the UI before adding new ones.

---

## 10. Shared Team Workstreams

Each workstream's focus below targets the gaps in Section 5 (Current Status), in priority order.

### Workstream 1: Data / Financial Twin (Jordan12369)

Owns Nessie, transaction normalization, recurrence detection, forecasting, Databricks and Financial Twin generation.

Built: normalization, recurrence detection, twin building, the Nessie client, the sandbox seeder, the switch that decides whether a twin comes from the fixture, Nessie or Databricks, and the read-back check that Alex comes out of the live sandbox recognisable (#65). The mock feed carries a known seasonal signal (`SEASONAL_WEIGHTS` in `ingest/generate_transactions.py`), and recurrence detection fits a recency-weighted mean and a per-month seasonal profile per category, recorded on the twin as forecast metadata (#59). Alex's demo twin (`fixtures/twin.json`) carries those profiles and that forecast, and it is now separate from the hand-written seed twin (`fixtures/twin_seed.json`) that the mock transaction feed is generated from, so the two can no longer feed each other. The Databricks build job (`build_job.py`, `databricks.yml`), the read-back of the twin it writes (`databricks_twin.py`) and MLflow tracking of twin builds (`tracking.py`) are in, behind flags.

Focus:

1. Run the Databricks build job and MLflow tracking against a real workspace and record the result here. Until then they are built but unverified live (Section 5).

### Workstream 2: Simulation / Intelligence (abimundayat26)

Owns the simulator, Monte Carlo, the goal compiler, counterfactual simulation, explainability and optimization. It also owns the alternatives UI.

Built: the deterministic and Monte Carlo simulation, explanations, optimization, the rule-based goal compiler, the LLM goal compiler (on wherever a key is set, with rules as the fallback), the alternatives panel, and user answers kept across a server restart. Both simulators apply a twin's per-month seasonal spending profile, and a twin without one simulates flat (#63). Explanations describe the forecast and a busy or quiet spending stretch after a purchase (#64, #69), and when no single alternative keeps every limit, the optimizer also tries waiting combined with a spending cut (#70). Also built: one-time obligations in the baseline and the optimizer, the Assistant backend (an intent router that separates goals, constraints, one-time obligations and answers about detected bills; drafts that only an explicit accept applies), the impact score, the earliest-date search, commit-a-purchase, and the overview, forecast and obligations read routes.

Focus:

1. Keep explanations and alternatives useful as the demo twin and obligations change.
2. Optionally, and only if the team reverses the Section 13 decision, have the LLM write explanations, rephrasing only the computed results.

### Workstream 3: Frontend / Integration (mkrishiv)

Owns the Next.js frontend, Twin visualization, the scenario UI, charts, API integration, the Financial Intent Graph and demo polish.

Built: a minimalist multi-page app (Overview, Plans & Assistant, Obligations, Purchase Simulator, Balance Trajectory, Insights) with a shared shell, the Goals & Limits panel, the Assistant chat with proposal cards, the scenario comparison with alternatives and commit actions, the balance trajectory chart, the forecast and processing-lineage panels on Insights (where the twin's data came from, separately from whether the backend is reachable), and handling of an offline backend. Frontend requirements live in `frontend/SPEC.md`. The earlier single-screen frontend and its Financial Intent Graph were removed.

Focus:

1. Demo polish and a rehearsal from a fresh clone (Phase 7), following `docs/demo-walkthrough.md`.

Ownership means responsibility, not exclusive permission to modify code.

A feature is not done until the demo shows it. Once a backend endpoint exists, the workstream that built it also builds its frontend (API client, types, UI), coordinating with Workstream 3 on layout. Workstream 3 owns the overall page, shared components, and demo polish.

---

## 11. Non-Goals During MVP

Do not prioritize:

* Hokie Passport integration,
* private Grubhub APIs,
* deep-learning forecasting,
* complex reinforcement learning,
* mobile app,
* production authentication,
* autonomous bank transfers,
* multiple dashboards,
* multi-bank production support,
* full multi-user collaboration.

ANS is a stretch feature unless the core product is already stable.

---

## 12. Demo Success Criterion

The single most important milestone is:

> A user can enter an $800 laptop purchase and see a meaningful baseline-versus-counterfactual financial future comparison.

Initially, the values behind this experience may be mocked.

Then mocks should be progressively replaced by real implementations without breaking the demo.

---

## 13. Decisions and Open Questions

These are decided by the team, not by an individual Claude Code session. A new open question goes in the second table with a proposed default; until the team decides it, use the default and label it as an assumption.

Decided:

| Question | Decision |
| --- | --- |
| What balance counts as "low balance"? | Checking below the user's own minimum checking balance, which they set in the app (`PUT /twin/{user_id}/minimum-balance`); $200 until they set one |
| Does the emergency reserve count checking only, or checking plus savings? | Checking plus savings |
| What is the simulation horizon? | Through the earliest goal deadline (2027-05-01 for Alex); 180 days when there are no goals; at most 730 days |
| Which LLM provider do we use? | Anthropic, Claude Sonnet 5 (`claude-sonnet-5`). The goal compiler defaults to `GOAL_COMPILER=llm`, but only takes effect where `ANTHROPIC_API_KEY` is set (the group lead's machine); with no key, with `GOAL_COMPILER=rules`, or when a call fails, the rule-based compiler runs, so a fresh clone works with no credentials. Explanations stay template-based. Changed from Haiku 4.5 by the group lead on 2026-09-19; made the default by the group lead on 2026-09-20. |
| Does the housing goal draw from the same money as the emergency reserve? | No; the goal must be met on top of the reserve |

Open:

| Question | Proposed default |
| --- | --- |
| (none yet) | |
