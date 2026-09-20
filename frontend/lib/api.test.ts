import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  compileGoal,
  createOneTimeObligation,
  createRecurringObligation,
  deleteGoal,
  deleteOneTimeObligation,
  deleteRecurringObligation,
  getExplanation,
  getForecast,
  getObligations,
  getOverview,
  getTwin,
  respondToClarification,
  runOptimization,
  runSimulation,
  saveGoals,
  setMinimumBalance,
  setReserve,
  updateGoal,
  updateOneTimeObligation,
  updateRecurringObligation,
} from "./api";
import mockOverview from "./mock/overview.json";
import mockTwin from "./mock/twin.json";
import mockForecast from "./mock/forecast.json";
import type {
  FinancialConstraint,
  FinancialTwin,
  Goal,
  GoalCompileResponse,
  ObligationsPayload,
  OptimizationResponse,
  OverviewPayload,
  SimulationRequest,
} from "./types";

const twin = mockTwin as FinancialTwin;
const overview = mockOverview as OverviewPayload;
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

  it("gets the typed Overview payload through the normal request path", async () => {
    backendReplies(200, overview);
    await expect(getOverview("alex user")).resolves.toEqual({
      data: overview,
      source: "api",
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toMatch(/\/twin\/alex%20user\/overview$/);
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces the backend detail when Overview is rejected", async () => {
    backendReplies(404, { detail: "No twin for user 'nobody'" });
    await expect(getOverview("nobody")).rejects.toMatchObject({
      status: 404,
      message: "No twin for user 'nobody'",
    });
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

  it("does not fall back to the bundled Overview", async () => {
    await expect(getOverview("alex")).rejects.toThrow("fetch failed");
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

describe("getObligations", () => {
  const listing: ObligationsPayload = {
    user_id: "alex",
    as_of: "2026-09-18",
    recurring: [
      {
        id: "rec_rent",
        name: "Rent",
        amount: 1200,
        frequency: "monthly",
        due_day: 1,
        active: true,
        origin: "detected",
        category_label: "Bill",
        needs_answer: false,
        options: [],
      },
    ],
    one_time: [
      {
        id: "one_dentist",
        name: "Dentist",
        amount: 180,
        due_date: "2026-10-02",
        account_id: "acc_checking",
        account_name: "Main checking",
        mandatory: true,
      },
    ],
  };

  it("reads the listing through the normal request path", async () => {
    backendReplies(200, listing);
    await expect(getObligations("alex user")).resolves.toEqual({
      data: listing,
      source: "api",
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toMatch(/\/twin\/alex%20user\/obligations$/);
    expect(init?.method).toBeUndefined();
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces the backend detail instead of a fixture listing", async () => {
    backendReplies(404, { detail: "No twin for user 'nobody'" });
    const result = getObligations("nobody");
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      status: 404,
      message: "No twin for user 'nobody'",
    });
  });

  it("has no bundled listing, so an unreachable backend throws", async () => {
    backendDown();
    await expect(getObligations("alex")).rejects.toThrow("fetch failed");
  });
});

/** The partial goal and limit writes the Goals & Limits panel uses (PL-9, PL-10). */
describe("goal and limit writes", () => {
  const saved = { ...twin, user_id: "alex" } as FinancialTwin;

  function lastCall() {
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    return {
      url: String(url),
      method: init?.method,
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    };
  }

  it("patches only the named fields, leaving the other goals alone", async () => {
    backendReplies(200, saved);
    await expect(
      updateGoal("alex", "goal_summer housing", { target_amount: 2500 }),
    ).resolves.toEqual({ data: saved, source: "api" });
    const call = lastCall();
    expect(call.url).toMatch(/\/twin\/alex\/goals\/goal_summer%20housing$/);
    expect(call.method).toBe("PATCH");
    expect(call.body).toEqual({ target_amount: 2500 });
  });

  it("deletes one goal without a body", async () => {
    backendReplies(200, saved);
    await deleteGoal("alex", "goal_trip");
    const call = lastCall();
    expect(call.url).toMatch(/\/twin\/alex\/goals\/goal_trip$/);
    expect(call.method).toBe("DELETE");
    expect(call.body).toBeUndefined();
  });

  it("puts the emergency reserve, where zero removes it", async () => {
    backendReplies(200, saved);
    await setReserve("alex", { amount: 0 });
    const call = lastCall();
    expect(call.url).toMatch(/\/twin\/alex\/reserve$/);
    expect(call.method).toBe("PUT");
    expect(call.body).toEqual({ amount: 0 });
  });

  it("throws a rejected edit rather than reporting it saved", async () => {
    backendReplies(404, { detail: "Unknown goal 'goal_gone'" });
    await expect(updateGoal("alex", "goal_gone", { target_amount: 10 })).rejects.toThrow(
      "Unknown goal 'goal_gone'",
    );
  });

  describe("when the backend is unreachable", () => {
    beforeEach(backendDown);

    it("does not pretend a goal or limit write succeeded locally", async () => {
      await expect(updateGoal("alex", "goal_trip", { target_amount: 10 })).rejects.toThrow(
        "fetch failed",
      );
      await expect(deleteGoal("alex", "goal_trip")).rejects.toThrow("fetch failed");
      await expect(setReserve("alex", { amount: 1500 })).rejects.toThrow("fetch failed");
    });
  });
});

describe("obligation writes", () => {
  /** Every write answers with the whole updated twin, which the caller adopts. */
  const saved = { ...twin, user_id: "alex" } as FinancialTwin;

  function lastCall() {
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    return {
      url: String(url),
      method: init?.method,
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
      signal: init?.signal,
    };
  }

  it("posts a new recurring obligation with exactly the declared fields", async () => {
    backendReplies(201, saved);
    const request = { name: "Gym", amount: 40, due_day: 5, mandatory: false };
    await expect(createRecurringObligation("alex", request)).resolves.toEqual({
      data: saved,
      source: "api",
    });
    const call = lastCall();
    expect(call.url).toMatch(/\/twin\/alex\/obligations\/recurring$/);
    expect(call.method).toBe("POST");
    expect(call.body).toEqual(request);
  });

  it("puts only the changed recurring fields, with the id encoded in the path", async () => {
    backendReplies(200, saved);
    await updateRecurringObligation("alex", "rec_gym membership", { active: false });
    const call = lastCall();
    expect(call.url).toMatch(/\/twin\/alex\/obligations\/recurring\/rec_gym%20membership$/);
    expect(call.method).toBe("PUT");
    expect(call.body).toEqual({ active: false });
  });

  it("deletes a recurring obligation without a body", async () => {
    backendReplies(200, saved);
    await deleteRecurringObligation("alex", "rec_gym");
    const call = lastCall();
    expect(call.url).toMatch(/\/twin\/alex\/obligations\/recurring\/rec_gym$/);
    expect(call.method).toBe("DELETE");
    expect(call.body).toBeUndefined();
  });

  it("posts a new one-time obligation against an account id, not its name", async () => {
    backendReplies(201, saved);
    const request = {
      name: "Dentist",
      amount: 180,
      due_date: "2026-10-02",
      account_id: "acc_checking",
      mandatory: true,
    };
    await createOneTimeObligation("alex", request);
    const call = lastCall();
    expect(call.url).toMatch(/\/twin\/alex\/obligations\/one-time$/);
    expect(call.method).toBe("POST");
    expect(call.body).toEqual(request);
  });

  it("puts one-time changes to the encoded id", async () => {
    backendReplies(200, saved);
    await updateOneTimeObligation("alex", "one_dentist", { amount: 200 });
    const call = lastCall();
    expect(call.url).toMatch(/\/twin\/alex\/obligations\/one-time\/one_dentist$/);
    expect(call.method).toBe("PUT");
    expect(call.body).toEqual({ amount: 200 });
  });

  it("deletes a one-time obligation without a body", async () => {
    backendReplies(200, saved);
    await deleteOneTimeObligation("alex", "one_dentist");
    const call = lastCall();
    expect(call.url).toMatch(/\/twin\/alex\/obligations\/one-time\/one_dentist$/);
    expect(call.method).toBe("DELETE");
    expect(call.body).toBeUndefined();
  });

  it("posts a clarification answer to the shared route", async () => {
    backendReplies(200, saved);
    const request = {
      user_id: "alex",
      obligation_id: "rec_unknown",
      category: "savings_transfer" as const,
    };
    await respondToClarification(twin, request);
    const call = lastCall();
    expect(call.url).toMatch(/\/clarifications\/respond$/);
    expect(call.method).toBe("POST");
    expect(call.body).toEqual(request);
  });

  it("arms the 10 s signal on a write, like every other request", async () => {
    backendReplies(200, saved);
    await deleteRecurringObligation("alex", "rec_gym");
    expect(lastCall().signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces a detected-delete conflict verbatim, with its status", async () => {
    backendReplies(409, { detail: "Detected payments can be paused, not deleted." });
    const result = deleteRecurringObligation("alex", "rec_rent");
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      status: 409,
      message: "Detected payments can be paused, not deleted.",
    });
  });

  it("joins a validation error list rather than dropping the later messages", async () => {
    backendReplies(422, {
      detail: [{ msg: "amount must be greater than 0" }, { msg: "due_day must be <= 31" }],
    });
    await expect(
      createRecurringObligation("alex", { name: "Gym", amount: -1, due_day: 40 }),
    ).rejects.toThrow("amount must be greater than 0; due_day must be <= 31");
  });

  describe("when the backend is unreachable", () => {
    beforeEach(backendDown);

    it("does not pretend any obligation write succeeded locally", async () => {
      await expect(
        createRecurringObligation("alex", { name: "Gym", amount: 40, due_day: 5 }),
      ).rejects.toThrow("fetch failed");
      await expect(
        updateRecurringObligation("alex", "rec_gym", { active: false }),
      ).rejects.toThrow("fetch failed");
      await expect(deleteRecurringObligation("alex", "rec_gym")).rejects.toThrow("fetch failed");
      await expect(
        createOneTimeObligation("alex", {
          name: "Dentist",
          amount: 180,
          due_date: "2026-10-02",
          account_id: "acc_checking",
        }),
      ).rejects.toThrow("fetch failed");
      await expect(
        updateOneTimeObligation("alex", "one_dentist", { amount: 200 }),
      ).rejects.toThrow("fetch failed");
      await expect(deleteOneTimeObligation("alex", "one_dentist")).rejects.toThrow("fetch failed");
    });
  });
});
