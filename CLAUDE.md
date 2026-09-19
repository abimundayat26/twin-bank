# TwinBank Claude Code Instructions

## Start Here

Before making architectural or implementation decisions:

1. Read `spec.md`.
2. Inspect the existing repository.
3. Understand the current implementation phase.
4. Do not assume planned features are already implemented.

TwinBank is currently following a demo-first vertical-slice strategy.

The highest priority is keeping a functioning end-to-end demo.

---

## Engineering Principles

Prefer:

* simple implementations,
* explicit data structures,
* small modules,
* pure functions where practical,
* straightforward tests,
* mockable integrations,
* incremental changes.

Avoid:

* unnecessary abstractions,
* premature production infrastructure,
* large unrelated refactors,
* speculative features,
* unnecessary dependencies,
* overengineering.

Hackathon reliability is more important than architectural perfection.

---

## Scope Discipline

Implement only the requested phase or feature.

Do not automatically continue into the next planned phase.

Do not add stretch features unless explicitly requested.

Do not redesign the product without discussing the change first.

When a simpler implementation satisfies the current requirements, prefer it.

---

## Shared Contracts

Financial Twin, goal, simulation, and optimization schemas are shared interfaces between workstreams.

Do not casually change shared schemas.

Before changing a shared contract:

1. identify why the change is necessary,
2. identify existing consumers,
3. prefer backwards-compatible changes,
4. explain the impact before implementation.

---

## LLM Responsibilities

LLMs may be used for:

* converting natural-language goals into structured data,
* asking clarification questions,
* translating structured results into natural-language explanations,
* optional future agent orchestration.

LLMs must not be used to:

* calculate balances,
* perform financial simulation,
* enforce hard financial constraints,
* invent account information,
* invent financial goals,
* produce unexplained financial risk values.

Financial calculations belong in deterministic or statistical code.

---

## External Integrations

Nessie, Databricks, and LLM providers must be replaceable with mocks or fixtures when practical.

The demo should not fail completely because an external API is unavailable.

Never commit API keys, tokens, credentials, or `.env` files.

Use `.env.example` for required configuration names.

---

## Before Coding

For non-trivial tasks:

1. inspect the relevant code,
2. summarize the current implementation,
3. identify the files likely to change,
4. propose a concise implementation plan,
5. mention important assumptions or risks.

Do not modify files until the requested task and current architecture are understood.

---

## While Coding

* Keep changes tightly scoped.
* Do not perform unrelated cleanup.
* Follow existing conventions.
* Add or update tests for meaningful logic changes.
* Keep external service code separated from business logic where practical.
* Prefer functions that are easy to test independently.

---

## After Coding

When finished:

1. run relevant tests,
2. run relevant lint/type checks if configured,
3. summarize what changed,
4. mention any assumptions,
5. mention remaining work,
6. stop instead of automatically implementing the next phase.

---

## Git Expectations

`main` should remain demoable.

Prefer small feature branches such as:

* `feat/twin-schema`
* `feat/deterministic-simulator`
* `feat/nessie-client`
* `feat/scenario-ui`

Avoid long-lived branches containing many unrelated features.

Do not commit secrets or generated environment files.

---

## Current Primary Goal

The first major milestone is a mocked but complete flow:

Alex
→ Financial Twin
→ enter $800 laptop purchase
→ Simulate
→ baseline vs counterfactual
→ explanation

Build this before pursuing advanced integrations or stretch features.
