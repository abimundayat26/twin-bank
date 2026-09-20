/**
 * The only module that talks to the backend.
 *
 * Phase 1: these functions already call the real endpoints
 * (`GET /twin/{user_id}` and `POST /simulate`). Only the initial twin load may
 * use a bundled fixture. Results and writes always need the backend: returning
 * a saved result or changing the twin only in browser memory would be false
 * success (frontend SPEC G-10 and G-14).
 *
 * `lib/mock/*.json` are generated from the API payloads. If a backend fixture
 * changes, regenerate them with `cd backend && uv run python -m
 * backend.sync_frontend_mocks`; `backend/tests/test_frontend_mocks.py` fails if they
 * drift apart. Do not hand-edit them.
 */

import mockTwin from "./mock/twin.json";
import type {
  AssistantMessageRequest,
  AssistantMessageResponse,
  AssistantOpening,
  ClarificationResponseRequest,
  DeclaredGoalsRequest,
  FinancialTwin,
  GoalCompileRequest,
  GoalCompileResponse,
  MinimumBalanceRequest,
  OptimizationRequest,
  OptimizationResponse,
  ProposalDecisionRequest,
  ProposalDecisionResponse,
  SimulationRequest,
  SimulationResponse,
} from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/**
 * `fetch` has no default timeout. A backend that accepts the connection and then
 * never answers would spin the UI forever, which is worse than being offline:
 * offline at least falls back to a fixture. Aborting turns a hang into that same
 * honest fallback.
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const LONG_RESULT_TIMEOUT_MS = 30_000;

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
    if (Array.isArray(body.detail)) {
      const messages = body.detail
        .map((item) =>
          typeof item === "object" && item !== null && "msg" in item
            ? (item as { msg?: unknown }).msg
            : undefined,
        )
        .filter((message): message is string => typeof message === "string");
      if (messages.length > 0) return messages.join("; ");
    }
  } catch {
    // Not JSON; fall through to the status line.
  }
  return `${response.status} ${response.statusText}`.trim();
}

async function getJson<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...init,
    // After `...init` so no caller can accidentally drop the timeout.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new ApiError(await errorMessage(response), response.status);
  }
  return (await response.json()) as T;
}

/** Only transport failures mean offline; bad payloads and backend errors stay visible. */
function unlessBackendUnavailable(error: unknown): void {
  if (error instanceof TypeError) return;
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return;
  }
  throw error;
}

export async function getTwin(userId: string): Promise<Loaded<FinancialTwin>> {
  try {
    return { data: await getJson<FinancialTwin>(`/twin/${userId}`), source: "api" };
  } catch (error) {
    unlessBackendUnavailable(error);
    console.warn("Falling back to the bundled twin fixture.", error);
    return { data: mockTwin as FinancialTwin, source: "fixture" };
  }
}

export async function runSimulation(
  request: SimulationRequest,
): Promise<Loaded<SimulationResponse>> {
  const data = await getJson<SimulationResponse>(
    "/simulate",
    { method: "POST", body: JSON.stringify(request) },
    LONG_RESULT_TIMEOUT_MS,
  );
  return { data, source: "api" };
}

/**
 * Ranked alternatives to a purchase (`POST /optimize`). There is no bundled
 * fixture: the options only mean something for the purchase actually entered,
 * so an unreachable backend throws and the page says alternatives need it.
 */
export async function runOptimization(
  request: OptimizationRequest,
): Promise<Loaded<OptimizationResponse>> {
  const data = await getJson<OptimizationResponse>(
    "/optimize",
    { method: "POST", body: JSON.stringify(request) },
    LONG_RESULT_TIMEOUT_MS,
  );
  return { data, source: "api" };
}

/**
 * Fetches a recent simulation again by id (`GET /explain/{simulation_id}`).
 * The backend keeps results in memory, so an id from before a restart is a 404.
 * There is no offline result fallback (G-14).
 */
export async function getExplanation(simulationId: string): Promise<Loaded<SimulationResponse>> {
  const data = await getJson<SimulationResponse>(
    `/explain/${encodeURIComponent(simulationId)}`,
  );
  return { data, source: "api" };
}

/**
 * Records Alex's answer to "What is this?" for an ambiguous obligation.
 * Offline, this rejects; the UI disables the control before it can be called.
 */
export async function respondToClarification(
  _twin: FinancialTwin,
  request: ClarificationResponseRequest,
): Promise<Loaded<FinancialTwin>> {
  const data = await getJson<FinancialTwin>("/clarifications/respond", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return { data, source: "api" };
}

/** Sets the checking balance Alex doesn't want to fall below (their low-balance line). */
export async function setMinimumBalance(
  twin: FinancialTwin,
  request: MinimumBalanceRequest,
): Promise<Loaded<FinancialTwin>> {
  const data = await getJson<FinancialTwin>(`/twin/${twin.user_id}/minimum-balance`, {
    method: "PUT",
    body: JSON.stringify(request),
  });
  return { data, source: "api" };
}

/**
 * Compiles what the user typed into draft goals and constraints
 * (`POST /goals/compile`). Drafts only: `saveGoals` is what saves them.
 *
 * There is no bundled fixture and no local parsing. The compiler only exists
 * server-side, so an unreachable backend throws instead of producing a draft:
 * a guessed amount or deadline is precisely what the compiler refuses to make
 * up (SPEC §2), and inventing one here would be worse than saying it is down.
 */
export async function compileGoal(
  request: GoalCompileRequest,
): Promise<Loaded<GoalCompileResponse>> {
  const data = await getJson<GoalCompileResponse>("/goals/compile", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return { data, source: "api" };
}

/**
 * Replaces the user's declared goals and reserve (`PUT /twin/{user_id}/goals`).
 *
 * `request` must be the complete declared set: the endpoint replaces, it never
 * appends, so sending one freshly typed goal drops every other goal and the
 * emergency reserve with it. Build the set with `mergeGoals` / `mergeConstraints`
 * from `lib/goals`. Offline, this rejects; no local write is reported as saved.
 */
export async function saveGoals(
  twin: FinancialTwin,
  request: DeclaredGoalsRequest,
): Promise<Loaded<FinancialTwin>> {
  const data = await getJson<FinancialTwin>(`/twin/${twin.user_id}/goals`, {
    method: "PUT",
    body: JSON.stringify(request),
  });
  return { data, source: "api" };
}

// --- Assistant ---------------------------------------------------------------
//
// None of these three has a fixture behind it. G-14: mock data may stand in for
// a twin when the backend is unreachable, never for an assistant result. A chat
// that answered from a fixture would be putting words in the Assistant's mouth,
// so these throw and the chat says it is offline instead.

/** The opening questions about detected payments TwinBank could not classify (AS-9). */
export async function getAssistantOpening(userId: string): Promise<AssistantOpening> {
  return getJson<AssistantOpening>(`/assistant/opening/${encodeURIComponent(userId)}`);
}

/** Reads one message into drafts and questions. The twin is unchanged (AS-1). */
export async function sendAssistantMessage(
  request: AssistantMessageRequest,
): Promise<AssistantMessageResponse> {
  return getJson<AssistantMessageResponse>("/assistant/message", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

/**
 * Accepts or rejects one draft. Accepting is the only thing the Assistant does
 * that touches the twin (AS-15), which is why it comes back with the whole
 * updated twin for the rest of the app to replace its own with.
 */
export async function decideProposal(
  proposalId: string,
  request: ProposalDecisionRequest,
): Promise<ProposalDecisionResponse> {
  return getJson<ProposalDecisionResponse>(
    `/assistant/proposals/${encodeURIComponent(proposalId)}/decision`,
    { method: "POST", body: JSON.stringify(request) },
  );
}
