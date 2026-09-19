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

> I need $2,000 for summer housing by May and want to keep at least $1,500 for emergencies.

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

### Current Status (2026-09-19)

| Phase | State |
| --- | --- |
| 1. Mocked end-to-end demo | Done |
| 2. Deterministic calculations | Done |
| 3. Nessie data | Client, seeder and twin source are wired, and Alex is seeded in the live sandbox. `USE_MOCKS=false` plus a key builds the twin from Nessie. Reading that twin back has not been checked yet. |
| 4. Monte Carlo | Done, including a fan chart in the UI |
| 5. Goal compilation and optimization | Done. Goal entry and the alternatives panel are in the UI. The rule-based compiler is the default; an LLM compiler sits behind `GOAL_COMPILER=llm` and falls back to rules. |
| 6. Databricks and MLflow | Not started |
| 7. Demo polish | Not started |

Main gaps, in priority order:

1. The demo still shows the hand-written twin, which is the intended default. Building it from transaction data works and Alex is seeded in the sandbox, but nobody has yet confirmed that a twin read back out of Nessie describes the same person.
2. There is no forecasting step. The simulation uses the twin's current averages.
3. The LLM goal compiler is off by default and explanations are template-based (Section 13).
4. Databricks and MLflow are not integrated.
5. There is no scripted demo walkthrough.

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

Expected API surface:

```text
GET  /health
GET  /twin/{user_id}
PUT  /twin/{user_id}/minimum-balance
PUT  /twin/{user_id}/goals
POST /twin/build
POST /goals/compile
POST /simulate
POST /optimize
GET  /explain/{simulation_id}
POST /clarifications/respond
```

Do not build all endpoints immediately.

Build only what the current phase requires.

All of these endpoints now exist. Several of them (goal compilation, optimization, twin build) are not yet used by the frontend. Wire existing endpoints into the UI before adding new ones.

---

## 10. Shared Team Workstreams

Each workstream's focus below targets the gaps in Section 5 (Current Status), in priority order.

### Workstream 1: Data / Financial Twin (Jordan12369)

Owns Nessie, transaction normalization, recurrence detection, forecasting, Databricks and Financial Twin generation.

Built: normalization, recurrence detection, twin building, the Nessie client, the sandbox seeder, and the switch that decides whether a twin comes from the fixture or from Nessie.

Focus:

1. Read Alex back out of Nessie and check he is still recognisable: the paycheck around $720 every 14 days, rent on the 1st, the goal and reserve carried through untouched (Section 2). Building the twin is wired and Alex is seeded, so this is the one step left to call Phase 3 finished. Seeding was only proved by running it for real — the seeder's tests mock Nessie, and so missed a payload Nessie rejects. Expect reading back to have its own version of that, and do not trust the mocked tests alone. The demo stays on fixtures by default either way.
2. Give the mock feed something to forecast, then forecast it.

   The generator draws every fortnight from the same distribution, so the feed has no trend and no seasonality in it. Measured over the year, grocery spending drifts by about one month-to-month standard deviation, which is noise. A forecaster fitted to this would be fitting noise, and a test asserting it found a trend would be asserting an artifact of the seed.

   So add a known signal first — a start-of-term spike, a holiday bump, a gentle drift — the same way `transactions.json` was generated from `twin.json` so recurrence detection could be tested on recovering it. Then a forecast has something real to recover.
3. Then the forecast itself. Today the simulation holds one flat `mean_14d` and `std_dev_14d` per category across the whole horizon, and recurrence detection computes that mean weighting a fortnight from eleven months ago the same as last fortnight. Recency weighting and a per-month seasonal factor are enough to start. Section 8 already calls for forecast metadata on the twin; there is no field for it yet, so that is a small shared-schema change of its own.
4. After the above, move data processing into Databricks with MLflow tracking, behind a flag.

### Workstream 2: Simulation / Intelligence (abimundayat26)

Owns the simulator, Monte Carlo, the goal compiler, counterfactual simulation, explainability and optimization. It also owns the alternatives UI.

Built: the deterministic and Monte Carlo simulation, explanations, optimization, the rule-based goal compiler, the LLM goal compiler behind a flag with rules as the fallback, the alternatives panel, and user answers kept across a server restart.

Focus:

1. Let the simulator use a spending forecast that changes over time (for example, a per-month factor per category), agreed with Workstream 1 so it matches their forecaster's output. Without a forecast on the twin, keep today's flat behaviour.
2. Optionally, and only if the team reverses the Section 13 decision, have the LLM write explanations, rephrasing only the computed results.

### Workstream 3: Frontend / Integration (mkrishiv)

Owns the Next.js frontend, Twin visualization, the scenario UI, charts, API integration, the Financial Intent Graph and demo polish.

Built: the twin view, the scenario comparison, explanations, the Financial Intent Graph, the fan chart, and handling of an offline backend.

Focus:

1. Goal entry: the user types a goal, reviews the compiled draft and any clarification questions, and confirms.
2. Show where the twin's data came from (fixture or Nessie).
3. Demo polish and a scripted walkthrough from a fresh clone (Phase 7).

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
| Which LLM provider do we use? | Anthropic, Claude Sonnet 5 (`claude-sonnet-5`), off by default behind `GOAL_COMPILER=llm`; explanations stay template-based. Changed from Haiku 4.5 by the group lead on 2026-09-19. |
| Does the housing goal draw from the same money as the emergency reserve? | No; the goal must be met on top of the reserve |

Open:

| Question | Proposed default |
| --- | --- |
| (none yet) | |
