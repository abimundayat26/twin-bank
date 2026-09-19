# TwinBank Claude Code Instructions

## Start Here

Before making architectural or implementation decisions:

1. Read `SPEC.md`.
2. Inspect the existing repository.
3. Understand the current implementation phase.
4. Do not assume planned features are already implemented.

TwinBank is currently following a demo-first vertical-slice strategy.

The highest priority is keeping a functioning end-to-end demo.

Three developers work on this repo at the same time, each usually running their own Claude Code session. Assume other people are changing other parts of the codebase while you work.

---

## Repository Layout

Target layout (some parts may not exist yet, so check before assuming):

```text
backend/            Python, FastAPI, uv
  src/backend/
    main.py         FastAPI app and routes
    schemas.py      shared Pydantic contracts (source of truth)
    fixtures.py     loads mock fixtures
  fixtures/         mock JSON data (Alex)
  tests/
frontend/           Next.js, TypeScript
.env.example        configuration names, no values
```

Commands:

* Backend install: `cd backend && uv sync`
* Backend run: `cd backend && uv run uvicorn backend.main:app --reload --port 8000`
* Backend tests: `cd backend && uv run pytest`
* Frontend runs on port 3000 and calls the backend at `NEXT_PUBLIC_API_URL`.

Update this section when the layout or commands change.

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

Phases describe what `main` demos, not what each person may work on. A workstream may build a later-phase component (for example, the Nessie client) in parallel, but it must stay behind the existing interface and mocks until it is ready. It must not break the current demo.

Do not add stretch features unless explicitly requested.

Do not redesign the product without discussing the change first.

When a simpler implementation satisfies the current requirements, prefer it.

---

## Shared Contracts

Financial Twin, goal, simulation, and optimization schemas are shared interfaces between workstreams.

Do not casually change shared schemas.

Once `backend/src/backend/schemas.py` exists, it is the single source of truth for these contracts. The JSON in `SPEC.md` is only illustrative. Frontend TypeScript types must mirror `schemas.py`.

Before changing a shared contract:

1. identify why the change is necessary,
2. identify existing consumers,
3. prefer backwards-compatible changes (add optional fields; do not rename or remove),
4. explain the impact before implementation.

Put schema changes in their own small PR, separate from feature work, so other workstreams can review and pull them quickly.

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

Mocks are the default. Real integrations must be enabled by an environment variable listed in `.env.example`, so a fresh clone runs the demo with no credentials.

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

Do not commit directly to `main`. Work on small feature branches and merge through pull requests, for example:

* `feat/twin-schema`
* `feat/deterministic-simulator`
* `feat/nessie-client`
* `feat/scenario-ui`

Avoid long-lived branches containing many unrelated features.

Because three people push concurrently:

* pull `main` before starting a task and before opening a PR,
* stage specific files, not `git add -A` or `git add .`,
* never force-push, rebase, or reset a branch someone else may be using,
* do not commit, push, or open PRs unless the developer asks,
* only change `uv.lock` or `package-lock.json` when adding or removing a dependency,
* do not reformat or reorganize files outside your task (this causes merge conflicts),
* do not edit `CLAUDE.md` or `SPEC.md` unless the developer explicitly asks (they are shared team agreements).

Do not commit secrets, `.env` files, `.venv`, `node_modules`, or build output.

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
