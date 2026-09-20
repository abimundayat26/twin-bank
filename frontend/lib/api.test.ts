import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  compileGoal,
  getForecast,
  getExplanation,
  getTwin,
  runOptimization,
  runSimulation,
  saveGoals,
  setMinimumBalance,
} from "./api";
import mockTwin from "./mock/twin.json";
import mockForecast from "./mock/forecast.json";
import type {
  FinancialConstraint,
  FinancialTwin,
  Goal,
  GoalCompileResponse,
  OptimizationResponse,
  SimulationRequest,
} from "./types";

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

  it("does not disguise a malformed success payload as an offline twin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    );
    await expect(getTwin("alex")).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("when the backend is unreachable", () => {
  beforeEach(backendDown);

  it("falls back to the bundled twin", async () => {
    await expect(getTwin("alex")).resolves.toEqual({ data: mockTwin, source: "fixture" });
  });

  it("falls back to the generated forecast mock", async () => {
    await expect(getForecast("alex")).resolves.toEqual({
      data: mockForecast,
      source: "fixture",
    });
  });

  it("does not fall back to a bundled simulation", async () => {
    await expect(runSimulation(request)).rejects.toThrow("fetch failed");
  });

  it("does not fall back to a bundled explanation", async () => {
    await expect(getExplanation("sim_fixture_alex_laptop")).rejects.toThrow("fetch failed");
  });

  it("does not pretend a write succeeded locally", async () => {
    await expect(setMinimumBalance(twin, { amount: 300 })).rejects.toThrow("fetch failed");
  });
});

describe("getForecast", () => {
  it("gets the user's baseline forecast from the API", async () => {
    backendReplies(200, mockForecast);
    await expect(getForecast("alex")).resolves.toEqual({ data: mockForecast, source: "api" });
    expect(vi.mocked(fetch).mock.calls[0][0]).toMatch(/\/twin\/alex\/forecast$/);
  });

  it("surfaces a backend error instead of replacing it with sample figures", async () => {
    backendReplies(422, { detail: "Twin has no accounts" });
    await expect(getForecast("alex")).rejects.toMatchObject({
      status: 422,
      message: "Twin has no accounts",
    });
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

describe("runOptimization", () => {
  it("posts the purchase to /optimize and returns the ranked options", async () => {
    const payload = { optimization_id: "opt_1", candidates: [] } as unknown as OptimizationResponse;
    backendReplies(200, payload);
    await expect(runOptimization(request)).resolves.toEqual({ data: payload, source: "api" });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toMatch(/\/optimize$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(request);
  });

  it("throws the backend's error", async () => {
    backendReplies(422, { detail: "Event date 2030-01-01 is outside the horizon" });
    await expect(runOptimization(request)).rejects.toMatchObject({ status: 422 });
  });

  it("has no fixture to fall back to, so an unreachable backend throws", async () => {
    backendDown();
    await expect(runOptimization(request)).rejects.toThrow("fetch failed");
  });
});

describe("compileGoal", () => {
  const draft = {
    user_id: "alex",
    text: "$2,000 for summer housing by May",
    goals: [],
    constraints: [],
    clarifications: [],
    unparsed: [],
    compiler: "rules",
  } as GoalCompileResponse;

  it("posts the text to /goals/compile and returns the draft", async () => {
    backendReplies(200, draft);
    await expect(compileGoal({ user_id: "alex", text: draft.text })).resolves.toEqual({
      data: draft,
      source: "api",
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toMatch(/\/goals\/compile$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ user_id: "alex", text: draft.text });
  });

  it("has no fixture to fall back to, so an unreachable backend throws", async () => {
    backendDown();
    // Nothing here may invent a goal from the text: the compiler is the only
    // thing allowed to parse it, and it is not reachable.
    await expect(compileGoal({ user_id: "alex", text: draft.text })).rejects.toThrow(
      "fetch failed",
    );
  });
});

describe("saveGoals", () => {
  const housing: Goal = {
    id: "goal_summer_housing",
    name: "Summer housing",
    target_amount: 2000,
    deadline: "2027-05-01",
    current_amount: 450,
    provenance: "declared",
  };
  const reserve: FinancialConstraint = {
    id: "con_emergency_reserve",
    type: "minimum_reserve",
    amount: 1500,
    description: "Keep at least $1,500 across checking and savings for emergencies.",
    provenance: "declared",
  };

  it("puts the whole declared set to the twin's goals endpoint", async () => {
    const saved = { ...twin, goals: [housing], constraints: [reserve] };
    backendReplies(200, saved);
    const request = { goals: [housing], constraints: [reserve] };
    await expect(saveGoals(twin, request)).resolves.toEqual({ data: saved, source: "api" });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toMatch(/\/twin\/alex\/goals$/);
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual(request);
  });

  it("throws a rejected declaration instead of pretending it saved", async () => {
    backendReplies(422, { detail: "Goal 'goal_car' deadline 2030-01-01 must be after 2026-09-19" });
    const result = saveGoals(twin, { goals: [housing] });
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ status: 422 });
  });

  describe("when the backend is unreachable", () => {
    beforeEach(backendDown);

    it("rejects instead of applying the goals locally", async () => {
      await expect(
        saveGoals(twin, { goals: [housing], constraints: [reserve] }),
      ).rejects.toThrow("fetch failed");
    });
  });
});
