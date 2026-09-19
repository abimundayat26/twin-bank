/**
 * The only module that talks to the backend.
 *
 * Phase 1: these functions already call the real endpoints
 * (`GET /twin/{user_id}` and `POST /simulate`). If the backend is unreachable
 * they fall back to the bundled fixtures in `lib/mock/`, so the demo still
 * runs from a fresh clone with nothing started. If the backend answers with an
 * error (for example a 422 for a purchase outside the horizon), they throw an
 * `ApiError` instead: a real error must never be replaced by fixture numbers.
 *
 * To drop the mocks later, delete the `catch` fallbacks below. No component
 * needs to change: they only ever see `FinancialTwin` / `SimulationResponse`.
 *
 * `lib/mock/*.json` are generated from the API payloads. If a backend fixture
 * changes, regenerate them with `cd backend && uv run python -m
 * backend.sync_frontend_mocks`; `backend/tests/test_frontend_mocks.py` fails if they
 * drift apart. Do not hand-edit them.
 */

import { money } from "./format";
import mockSimulation from "./mock/simulation.json";
import mockTwin from "./mock/twin.json";
import type {
  ClarificationResponseRequest,
  FinancialTwin,
  MinimumBalanceRequest,
  SimulationRequest,
  SimulationResponse,
} from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Where a payload came from, so the UI can be honest about it. */
export type DataSource = "api" | "fixture";

export interface Loaded<T> {
  data: T;
  source: DataSource;
}

/** The backend was reached and returned an error. Never replaced by a fixture. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** FastAPI's `detail` is a string for our errors and a list for validation errors. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail) && typeof body.detail[0]?.msg === "string") {
      return body.detail[0].msg;
    }
  } catch {
    // Not JSON; fall through to the status line.
  }
  return `${response.status} ${response.statusText}`.trim();
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    throw new ApiError(await errorMessage(response), response.status);
  }
  return (await response.json()) as T;
}

/** Only a backend that could not be reached falls back to fixtures. */
function unlessApiError(error: unknown): void {
  if (error instanceof ApiError) throw error;
}

export async function getTwin(userId: string): Promise<Loaded<FinancialTwin>> {
  try {
    return { data: await getJson<FinancialTwin>(`/twin/${userId}`), source: "api" };
  } catch (error) {
    unlessApiError(error);
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
    unlessApiError(error);
    console.warn("Falling back to the bundled simulation fixture.", error);
    // Returned verbatim: the numbers do not respond to the request or to the
    // user's answers. `is_mock` says so, and the page shows an offline notice.
    return { data: mockSimulation as SimulationResponse, source: "fixture" };
  }
}

/**
 * Fetches a recent simulation again by id (`GET /explain/{simulation_id}`).
 * The backend keeps results in memory, so an id from before a restart is a 404.
 * Offline, only the bundled fixture's id can be answered.
 */
export async function getExplanation(simulationId: string): Promise<Loaded<SimulationResponse>> {
  try {
    const data = await getJson<SimulationResponse>(
      `/explain/${encodeURIComponent(simulationId)}`,
    );
    return { data, source: "api" };
  } catch (error) {
    unlessApiError(error);
    const fixture = mockSimulation as SimulationResponse;
    if (simulationId !== fixture.simulation_id) throw error;
    console.warn("Falling back to the bundled simulation fixture.", error);
    return { data: fixture, source: "fixture" };
  }
}

/**
 * Records Alex's answer to "What is this?" for an ambiguous obligation.
 * Offline, the answer is applied to the local twin so the UI still reflects it.
 */
export async function respondToClarification(
  twin: FinancialTwin,
  request: ClarificationResponseRequest,
): Promise<Loaded<FinancialTwin>> {
  try {
    const data = await getJson<FinancialTwin>("/clarifications/respond", {
      method: "POST",
      body: JSON.stringify(request),
    });
    return { data, source: "api" };
  } catch (error) {
    unlessApiError(error);
    console.warn("Backend unavailable; keeping the answer locally.", error);
    const obligations = twin.obligations.map((o) =>
      o.id === request.obligation_id ? { ...o, declared_category: request.category } : o,
    );
    return { data: { ...twin, obligations }, source: "fixture" };
  }
}

/** Sets the checking balance Alex doesn't want to fall below (their low-balance line). */
export async function setMinimumBalance(
  twin: FinancialTwin,
  request: MinimumBalanceRequest,
): Promise<Loaded<FinancialTwin>> {
  try {
    const data = await getJson<FinancialTwin>(`/twin/${twin.user_id}/minimum-balance`, {
      method: "PUT",
      body: JSON.stringify(request),
    });
    return { data, source: "api" };
  } catch (error) {
    unlessApiError(error);
    console.warn("Backend unavailable; keeping the minimum locally.", error);
    const constraints = [
      ...twin.constraints.filter((c) => c.type !== "minimum_checking_balance"),
      {
        id: "con_minimum_checking",
        type: "minimum_checking_balance" as const,
        amount: request.amount,
        description: `Keep at least ${money(request.amount)} in checking.`,
        provenance: "declared" as const,
      },
    ];
    return { data: { ...twin, constraints }, source: "fixture" };
  }
}
