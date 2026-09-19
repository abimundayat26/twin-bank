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
| 3. Nessie data | Done. Alex is seeded in the live sandbox, and `USE_MOCKS=false` plus a key builds the twin from Nessie. Read back from the live sandbox on 2026-09-19, Alex is recognisable (`backend.nessie.readback`, #65); Nessie stores amounts in whole dollars (#68). The demo stays on fixtures by default. |
| 4. Monte Carlo | Done, including a fan chart in the UI |
| 5. Goal compilation and optimization | Done. Goal entry and the alternatives panel are in the UI. The rule-based compiler is the default; an LLM compiler sits behind `GOAL_COMPILER=llm` and falls back to rules. |
| 6. Databricks and MLflow | Backend done, not yet visible. Every twin build logs an MLflow run behind `TRACK_TWIN_BUILDS` (#76, #77, #78, #80); the build runs as a Databricks asset bundle job (`backend/databricks.yml`, #79, #83, #90); `DATABRICKS_TWIN_PATH` serves the twin that job wrote and labels its provenance (#92, #93, #96). None of it has been run end to end against a real workspace, and the UI does not show lineage yet. |
| 7. Demo polish | In progress. The single page is now an app shell with Overview, Purchase Simulator, Balance Trajectory and Plans routes (#84–#89), components carry tests (#95), three display defects are fixed (#94), and the palette matches Section 6 (#98). Forecast & Data is open in #97. The frontend specification (`frontend/SPEC.md`) defines the rest. |
| 8. Stretch (ANS) | Not started, and out of scope until Phase 7 is finished |

Main gaps, in priority order:

1. One-time declared obligations are specified in `frontend/SPEC.md` but have no shared contract, no compiler support and no place in the baseline simulation. Everything downstream of them is blocked until that contract lands.
2. The TwinBank Assistant does not exist. Goal entry and category clarification are separate widgets rather than one conversation that routes intent.
3. Phase 6 is invisible. Nothing in the UI says whether a twin came through Databricks, and no MLflow lineage reaches the browser.
4. Forecast & Data is unfinished (#97), so the seasonal forecast that the simulator already uses is still not explained to the user.
5. There is no scripted demo walkthrough and no pre-demo verification checklist.
6. Explanations remain template-based by decision (Section 13), and the LLM goal compiler stays off by default.

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

All of these endpoints now exist, and the frontend uses all of them except `POST /twin/build`. Wire existing endpoints into the UI before adding new ones.

---

## 10. Shared Team Workstreams

Phases 1 to 5 are finished, so the workstreams below are no longer split by layer alone. They are
split by the gaps in Section 5, and reweighted for the remaining push: Workstream 2 carries the
largest share because one-time obligations and the Assistant both start in its code and block the
other two.

Target split of remaining effort:

| Workstream | Owner | Share |
| --- | --- | --- |
| 1. Data, Forecast and Platform | Jordan12369 | 30% |
| 2. Simulation, Intelligence and Demo | abimundayat26 | 40% |
| 3. Frontend and Integration | mkrishiv | 30% |

Shares describe effort, not exclusive permission. Ownership means responsibility for the gap, and a
feature is not done until the demo shows it.

### Sequencing constraint

Two pieces of work gate the others and must land first:

1. The one-time obligation contract in `schemas.py` (Workstream 2). Workstream 3 cannot build the
   obligation UI and Workstream 1 cannot include obligations in a built twin until it exists.
2. The lineage contract that exposes Databricks and MLflow metadata over the API (Workstream 1).
   Workstream 3 cannot build the Forecast & Data provenance surface until it exists.

Both are small schema-only pull requests, per the Shared Contracts rules in `CLAUDE.md`. Ship them
before the feature work that depends on them.

---

### Workstream 1: Data, Forecast and Platform (Jordan12369) — 30%

Owns Nessie, transaction normalization, recurrence detection, forecasting, Databricks, MLflow and
Financial Twin generation.

Built: normalization, recurrence detection, twin building, the Nessie client, the sandbox seeder,
the fixture-or-Nessie switch, the read-back check (#65), the recency-weighted per-month seasonal
profiles (#59), Alex's rebalanced seasonal demo twin (#72), MLflow run logging behind
`TRACK_TWIN_BUILDS` (#76, #77, #78, #80), the Databricks asset bundle build job (#79, #83, #90) and
the Databricks twin source with its provenance label (#92, #93, #96).

Focus, in order:

1. **Prove Phase 6 against a real workspace.** The Databricks job and MLflow logging are written but
   have never run end to end outside tests. Run the bundle, log a real build, serve the resulting
   twin through `DATABRICKS_TWIN_PATH`, and write down what the demo can honestly claim.
2. **Ship the lineage contract.** Expose the metadata Forecast & Data needs — processing location,
   MLflow run identifier, as-of date, observation window, forecast method, seasonal profiles — as a
   schema addition on the twin or a dedicated endpoint. Identifiers and metadata only; no
   credentials, no connection strings, nothing that could reach the browser as a secret.
3. **Verify the official Nessie demo path.** Confirm `USE_MOCKS=false` plus a key still runs the
   whole laptop story, and settle the Section 13 open question on whether the official demo runs on
   fixtures or on Nessie.
4. **Include confirmed one-time obligations in the built twin**, once Workstream 2's contract lands.
5. **Close out `feat/forecast-estimator`.** Its one unmerged commit (shrink monthly factors toward
   flat) looks superseded by the merged `feat/forecast-shrinkage`. Merge it or delete the branch.

---

### Workstream 2: Simulation, Intelligence and Demo (abimundayat26) — 40%

Owns the simulator, Monte Carlo, the goal compiler, counterfactual simulation, explainability,
optimization, the one-time obligation contract, Assistant intent routing, and the demo script.

Built: deterministic and Monte Carlo simulation, explanations, optimization, the rule-based goal
compiler, the LLM goal compiler behind a flag with rules as the fallback, the alternatives panel,
user answers kept across a restart, seasonal profiles applied in both simulators (#63),
forecast-aware and busy-stretch explanations (#64, #69), and combined wait-plus-cut alternatives
(#70).

Focus, in order:

1. **One-time declared obligations, end to end.** This is the largest single gap and it blocks the
   other two workstreams.
   - Ship the shared contract in `schemas.py` first, as its own small pull request.
   - Extend the goal compiler to draft a one-time obligation from natural language, with
     clarification questions when the amount, date or name is missing.
   - Include confirmed obligations in the baseline simulation and make the optimizer aware of them,
     so a laptop is weighed against real upcoming commitments rather than against spending alone.
   - Keep a hypothetical purchase visibly distinct from a declared obligation.
2. **Assistant intent routing.** One conversation must tell a goal from a constraint, from a
   detected-obligation classification, from a one-time obligation, and ask when it is ambiguous.
   Own the routing behavior and the honest provenance label on every reply — rules, deterministic
   template, or the optional configured model. Workstream 3 builds the conversation layout on top.
3. **Fix two demo defects found on 2026-09-19.**
   - The rules compiler does not parse relative month names: "save $2,000 for a trip by next June"
     returns zero goals and asks for a deadline. Teach it relative months, or pin the demo script to
     explicit dates and record that choice here.
   - `/explain` labels two different statistics as the balance "bottoming out" — the expected-value
     path and the median future — and shows them adjacent. Distinguish them in wording so they do
     not read as numbers that disagree.
4. **Own the scripted demo walkthrough and the pre-demo verification checklist.** The Section 12
   success criterion is this workstream's, so the script that proves it is too. Rehearse it from a
   fresh clone.
5. **Keep explanations and alternatives correct** as seasonal twins and one-time obligations change
   what the simulator sees.

---

### Workstream 3: Frontend and Integration (mkrishiv) — 30%

Owns the Next.js frontend, twin visualization, the scenario UI, charts, API integration, the
Financial Intent Graph, the Assistant conversation layout and demo polish.

Built: the app shell and routes (#87, #88), the twin provider (#85), twin provenance (#84, #96),
scenario comparison, explanations, the Financial Intent Graph, the fan chart, the simulator
trajectory chart (#89), goal entry with compiled drafts and clarifications, offline-backend
handling, component-level test coverage (#86, #95), three display fixes (#94) and the Section 6
palette (#98).

Focus, in order:

1. **Finish Forecast & Data (#97).** Show the data source, as-of date and observation window,
   explain recency weighting and seasonality in plain language, and render an honest unavailable
   state when metadata is missing. Add the Databricks processing-location and MLflow lineage surface
   once Workstream 1's contract lands, including pending, stale-run, failed-run and local-fallback
   states.
2. **Build the Assistant conversation layout** on Plans & Assistant, with visibly separate goal and
   obligation summaries, review before anything saves, recoverable input on failure, and accurate
   rules/template/model labels supplied by Workstream 2.
3. **Redesign the Intent Graph** (`frontend/SPEC.md` Increment 7): stable directional layout,
   legend, plain-language introduction, accessible fallback and collision handling.
4. **Responsive and accessibility pass** (Increment 8): supported widths, long-content cases,
   collision regression checks, no unintended scrolling.

---

Ownership means responsibility, not exclusive permission to modify code. Once a backend endpoint
exists, the workstream that built it also builds its frontend, coordinating with Workstream 3 on
layout. Workstream 3 owns the overall page, shared components and demo polish.

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
| Does the official demo run on fixtures or on live Nessie? | Fixtures. Section 5 says the demo stays on fixtures by default, but `frontend/SPEC.md` Section 4 says the official demo "requires Nessie". Until the team decides, run the demo on fixtures and treat Nessie as the verified-but-optional path. Workstream 1 owns closing this. |
| Who reviews a one-time obligation before it enters the baseline? | The user, explicitly, in the Assistant. Nothing enters a simulation without confirmation, matching the existing goal flow. |
