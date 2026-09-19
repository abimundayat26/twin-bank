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

* OpenAI or Anthropic.

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

This is conceptual and may evolve.

---

## 9. Core API

Expected API surface:

```text
GET  /health
GET  /twin/{user_id}
POST /twin/build
POST /goals/compile
POST /simulate
POST /optimize
GET  /explain/{simulation_id}
POST /clarifications/respond
```

Do not build all endpoints immediately.

Build only what the current phase requires.

---

## 10. Shared Team Workstreams

### Workstream 1 — Data / Financial Twin

Owns:

* Nessie,
* transaction normalization,
* recurrence detection,
* forecasting,
* Databricks,
* Financial Twin generation.

### Workstream 2 — Simulation / Intelligence

Owns:

* deterministic simulator,
* Monte Carlo,
* goal compiler,
* counterfactual simulation,
* explainability,
* optimization.

### Workstream 3 — Frontend / Integration

Owns:

* Next.js frontend,
* Twin visualization,
* scenario UI,
* charts,
* API integration,
* Financial Intent Graph,
* demo polish.

Ownership means responsibility, not exclusive permission to modify code.

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
