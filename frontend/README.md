# TwinBank frontend

Next.js (App Router), React 19, TypeScript and Tailwind. Setup, the backend it talks to and the offline
behaviour are in the [root README](../README.md); the product rules for every page are in [`SPEC.md`](SPEC.md).

```bash
npm install
npm run dev        # http://localhost:3000
npm run lint
npm run typecheck  # generates Next's route types first, so it works on a fresh clone
npm test           # Vitest
npm run build
```

Requires Node 22. The backend URL comes from `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`).

## Pages

| Route | Page |
| --- | --- |
| `/` | Overview |
| `/plans` | Plans & Assistant: the chat and the Goals & Limits panel |
| `/obligations` | Obligations |
| `/simulate` | Purchase Simulator |
| `/trajectory` | Balance Trajectory |
| `/insights` | Forecast & Data |

## Layout

| Path | What it holds |
| --- | --- |
| `app/` | One folder per route, each with a `page.tsx` |
| `components/` | Panels and charts. Subfolders: `assistant/`, `insights/`, `twin/` |
| `lib/api.ts` | The only module that talks to the backend, including the offline fallback |
| `lib/types.ts` | TypeScript mirror of `backend/src/backend/schemas.py`. Change the schema first |
| `lib/state/` | `TwinProvider`, the shared twin state |
| `lib/mock/` | Copies of the backend fixtures for offline use. Generated: run `uv run python -m backend.sync_frontend_mocks` in `backend/`, do not edit by hand |
| `lib/navigation.ts` | The menu destinations |

The frontend never calculates a balance, a probability or an impact level; it displays what the backend
returns.
