/**
 * The only module that talks to the backend.
 *
 * Phase 1: these functions already call the real endpoints
 * (`GET /twin/{user_id}` and `POST /simulate`). If the backend is unreachable
 * they fall back to the bundled fixtures in `lib/mock/`, so the demo still
 * runs from a fresh clone with nothing started.
 *
 * To drop the mocks later, delete the `catch` fallbacks below. No component
 * needs to change: they only ever see `FinancialTwin` / `SimulationResponse`.
 *
 * `lib/mock/*.json` are generated from the API payloads. If a backend fixture
 * changes, regenerate them with `cd backend && uv run python -m
 * backend.sync_frontend_mocks`; `backend/tests/test_fixtures.py` fails if they
 * drift apart. Do not hand-edit them.
 */

import mockSimulation from "./mock/simulation.json";
import mockTwin from "./mock/twin.json";
import type { FinancialTwin, SimulationRequest, SimulationResponse } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Where a payload came from, so the UI can be honest about it. */
export type DataSource = "api" | "fixture";

export interface Loaded<T> {
  data: T;
  source: DataSource;
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getTwin(userId: string): Promise<Loaded<FinancialTwin>> {
  try {
    return { data: await getJson<FinancialTwin>(`/twin/${userId}`), source: "api" };
  } catch (error) {
    console.warn("Falling back to the bundled twin fixture.", error);
    return { data: mockTwin as FinancialTwin, source: "fixture" };
  }
}

export async function runSimulation(
  request: SimulationRequest,
): Promise<Loaded<SimulationResponse>> {
  try {
    const data = await getJson<SimulationResponse>("/simulate", {
      method: "POST",
      body: JSON.stringify(request),
    });
    return { data, source: "api" };
  } catch (error) {
    console.warn("Falling back to the bundled simulation fixture.", error);
    // Returned verbatim, exactly as the mocked backend does: the numbers do
    // not respond to the request yet. `is_mock` and `assumptions` say so.
    return { data: mockSimulation as SimulationResponse, source: "fixture" };
  }
}
