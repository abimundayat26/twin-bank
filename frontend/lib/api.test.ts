import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, getTwin, runSimulation, setMinimumBalance } from "./api";
import mockSimulation from "./mock/simulation.json";
import mockTwin from "./mock/twin.json";
import type { FinancialTwin, SimulationRequest } from "./types";

const twin = mockTwin as FinancialTwin;
const request = {
  user_id: "alex",
  events: [
    {
      type: "purchase",
      description: "Laptop",
      amount: 800,
      date: "2026-09-20",
      account_id: "acc_checking",
    },
  ],
} as SimulationRequest;

function backendDown() {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
}

function backendReplies(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("when the backend is reachable", () => {
  it("returns its payload, marked as coming from the API", async () => {
    backendReplies(200, twin);
    await expect(getTwin("alex")).resolves.toEqual({ data: twin, source: "api" });
  });

  it("throws the backend's error instead of falling back to fixtures", async () => {
    backendReplies(422, { detail: "Event date 2030-01-01 is outside the horizon" });
    const result = runSimulation(request);
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      status: 422,
      message: "Event date 2030-01-01 is outside the horizon",
    });
  });

  it("uses the first message of a validation error list", async () => {
    backendReplies(422, { detail: [{ msg: "amount must be positive" }] });
    await expect(runSimulation(request)).rejects.toThrow("amount must be positive");
  });
});

describe("when the backend is unreachable", () => {
  beforeEach(backendDown);

  it("falls back to the bundled twin", async () => {
    await expect(getTwin("alex")).resolves.toEqual({ data: mockTwin, source: "fixture" });
  });

  it("falls back to the bundled simulation", async () => {
    await expect(runSimulation(request)).resolves.toEqual({
      data: mockSimulation,
      source: "fixture",
    });
  });

  it("keeps a new minimum balance locally, replacing any earlier one", async () => {
    const first = await setMinimumBalance(twin, { amount: 300 });
    const second = await setMinimumBalance(first.data, { amount: 250 });
    const minimums = second.data.constraints.filter((c) => c.type === "minimum_checking_balance");
    expect(second.source).toBe("fixture");
    expect(minimums).toHaveLength(1);
    expect(minimums[0].amount).toBe(250);
  });
});

describe("when the backend accepts the connection but never answers", () => {
  it("arms an abort signal on every request", async () => {
    backendReplies(200, twin);
    await getTwin("alex");
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to a fixture instead of spinning forever", async () => {
    // What `AbortSignal.timeout` makes `fetch` reject with once it fires.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("signal timed out", "TimeoutError")),
    );
    await expect(getTwin("alex")).resolves.toEqual({ data: mockTwin, source: "fixture" });
  });

  it("still surfaces a real rejection, which a timeout must not mask", async () => {
    backendReplies(404, { detail: "No twin for user 'nobody'" });
    await expect(getTwin("nobody")).rejects.toBeInstanceOf(ApiError);
  });
});
