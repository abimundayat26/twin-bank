# Repository Guidelines

## Project Structure & Module Organization

The FastAPI backend lives in `backend/src/backend/`; routes are in `main.py`, Pydantic contracts in `schemas.py`, ingestion logic in `ingest/`, and simulation code in `simulation/`. Tests are under `backend/tests/`, with demo data in `backend/fixtures/`. The Next.js frontend uses `app/` for routes, `components/` for UI, `lib/` for API and domain helpers, and `lib/mock/` for fixture copies. Read `SPEC.md` before changing product behavior and `frontend/AGENTS.md` before frontend work.

## Build, Test, and Development Commands

Run commands from the relevant subdirectory:

```bash
cd backend && uv sync
cd backend && uv run uvicorn backend.main:app --reload --port 8000
cd backend && uv run pytest
cd frontend && npm install
cd frontend && npm run dev
cd frontend && npm run lint && npm run typecheck && npm test
cd frontend && npm run build
```

API docs run at `http://localhost:8000/docs`; the frontend runs at `http://localhost:3000`. Mocks are enabled by default.

## Coding Style & Naming Conventions

Use four spaces and type hints in Python; prefer small, explicit functions and Pydantic models. Use two spaces, strict TypeScript, functional React components, and the `@/` import alias in the frontend. Name Python tests `test_<behavior>` and TypeScript tests `*.test.ts`. Use `PascalCase` for components and types, `camelCase` for JavaScript functions, and `snake_case` for Python functions. ESLint with Next.js core-web-vitals and TypeScript rules is the frontend formatter/lint authority.

## Testing Guidelines

Backend tests use pytest; frontend tests use Vitest. Add focused tests for behavior changes, especially simulation logic, API errors, and fixture fallback. No coverage threshold is enforced. When changing `backend/src/backend/schemas.py`, update `frontend/lib/types.ts` and test both sides. Keep mirrored fixtures synchronized.

## Commit & Pull Request Guidelines

Recent commits use short, imperative subjects such as `Keep user answers across a server restart`. Use focused branches like `feat/scenario-ui`; do not commit directly to `main`. PRs should explain the user-visible behavior, list validation performed, link relevant issues, and include screenshots for UI changes. Keep shared-schema changes small and isolated. Stage only task-related files and update lockfiles only when dependencies change.

## Security & Configuration

Copy `.env.example` to `.env` for local overrides. Never commit credentials, `.env`, generated build output, `node_modules`, or `.venv`. Keep external integrations optional and preserve fixture fallback behavior so the demo remains usable offline.

Follow the "API Keys and Model Access" rules in `CLAUDE.md` without exception: never read `.env`, print secrets, or call a model API, and keep `GOAL_COMPILER=rules`.
