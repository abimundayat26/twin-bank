import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  compileGoal,
  getTwin,
  runOptimization,
  runSimulation,
  saveGoals,
  setMinimumBalance,
} from "./api";
import mockSimulation from "./mock/simulation.json";
import mockTwin from "./mock/twin.json";
import type {
  FinancialConstraint,
  FinancialTwin,
  Goal,
  GoalCompileResponse,
  OneTimeObligation,
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

  const insurance: OneTimeObligation = {
    id: "one_car_insurance",
    name: "Car insurance",
    amount: 450,
    due_date: "2026-10-15",
    account_id: "acc_checking",
    mandatory: true,
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

    it("applies the set locally, reserve and all", async () => {
      const loaded = await saveGoals(twin, { goals: [housing], constraints: [reserve] });
      expect(loaded.source).toBe("fixture");
      expect(loaded.data.goals).toEqual([housing]);
      expect(loaded.data.constraints).toEqual([reserve]);
    });

    it("drops a reserve the request leaves out, as the backend would", async () => {
      const withReserve = { ...twin, constraints: [reserve] };
      const loaded = await saveGoals(withReserve, { goals: [housing], constraints: [] });
      expect(loaded.data.constraints).toEqual([]);
    });

    it("keeps the saved checking minimum when the request carries none", async () => {
      const floor = await setMinimumBalance(twin, { amount: 300 });
      const loaded = await saveGoals(floor.data, { goals: [housing], constraints: [reserve] });
      const floors = loaded.data.constraints.filter(
        (c) => c.type === "minimum_checking_balance",
      );
      expect(floors).toHaveLength(1);
      expect(floors[0].amount).toBe(300);
    });

    // `twin_store.set_goals`: an omitted field keeps what was confirmed, an
    // empty list clears it. Mirrored so the offline demo cannot disagree with
    // the real one about what is owed.
    it("applies the one-time obligations the request carries", async () => {
      const loaded = await saveGoals(twin, { goals: [housing], one_time_obligations: [insurance] });
      expect(loaded.data.one_time_obligations).toEqual([insurance]);
    });

    it("keeps the confirmed obligations when the request omits the field", async () => {
      const owing = { ...twin, one_time_obligations: [insurance] };
      const loaded = await saveGoals(owing, { goals: [housing] });
      expect(loaded.data.one_time_obligations).toEqual([insurance]);
    });

    it("clears them for an empty list, as the backend does", async () => {
      const owing = { ...twin, one_time_obligations: [insurance] };
      const loaded = await saveGoals(owing, { goals: [housing], one_time_obligations: [] });
      expect(loaded.data.one_time_obligations).toEqual([]);
    });

    it("holds none for a twin that predates the field", async () => {
      const older: FinancialTwin = { ...twin };
      delete older.one_time_obligations;
      const loaded = await saveGoals(older, { goals: [housing] });
      expect(loaded.data.one_time_obligations).toEqual([]);
    });
  });
});
