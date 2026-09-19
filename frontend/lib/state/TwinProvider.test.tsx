import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialTwin, SimulationResponse } from "@/lib/types";
import mockSimulation from "@/lib/mock/simulation.json";
import mockTwin from "@/lib/mock/twin.json";

// The provider is the only thing that talks to the API, so the API is the only
// thing these tests fake. Everything else is the real provider.
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getTwin: vi.fn(),
    runSimulation: vi.fn(),
    runOptimization: vi.fn(),
    saveGoals: vi.fn(),
    setMinimumBalance: vi.fn(),
    respondToClarification: vi.fn(),
    compileGoal: vi.fn(),
  };
});

import * as api from "@/lib/api";
import { TwinProvider, useTwin } from "./TwinProvider";

const TWIN = mockTwin as unknown as FinancialTwin;
const SIMULATION = mockSimulation as unknown as SimulationResponse;

/** Surfaces the bits of provider state these tests assert on. */
function Probe() {
  const t = useTwin();
  return (
    <div>
      <span data-testid="twin">{t.twin ? t.twin.user_id : "none"}</span>
      <span data-testid="source">{t.source ?? "none"}</span>
      <span data-testid="error">{t.twinError ?? "none"}</span>
      <span data-testid="simulation">{t.simulation ? t.simulation.simulation_id : "none"}</span>
      <span data-testid="optimization">{t.optimization ? "some" : "none"}</span>
      <button onClick={() => void t.simulate({ ...SIMULATION.request.events[0] })}>sim</button>
      <button onClick={() => t.setMinimum(300)}>min</button>
      <button onClick={() => void t.optimize()}>opt</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <TwinProvider>
      <Probe />
    </TwinProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.runSimulation).mockResolvedValue({ data: SIMULATION, source: "api" });
  vi.mocked(api.runOptimization).mockResolvedValue({
    data: { user_id: "alex", candidates: [] } as never,
    source: "api",
  });
  vi.mocked(api.setMinimumBalance).mockResolvedValue({ data: TWIN, source: "api" });
});

describe("TwinProvider", () => {
  it("loads the twin once on mount", async () => {
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("twin")).toHaveTextContent("alex"));
    expect(screen.getByTestId("source")).toHaveTextContent("api");
    expect(api.getTwin).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected load instead of showing a twin", async () => {
    vi.mocked(api.getTwin).mockRejectedValue(new Error("boom"));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("boom"));
    expect(screen.getByTestId("twin")).toHaveTextContent("none");
  });

  it("keeps the offline fixture's source so the UI can label it", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "fixture" });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("source")).toHaveTextContent("fixture"));
  });

  it("clears the simulation when a declared fact changes", async () => {
    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("twin")).toHaveTextContent("alex"));

    await user.click(screen.getByText("sim"));
    await waitFor(() =>
      expect(screen.getByTestId("simulation")).toHaveTextContent(SIMULATION.simulation_id),
    );

    // A new minimum balance moves the twin, so the old projection is stale.
    await user.click(screen.getByText("min"));
    await waitFor(() => expect(screen.getByTestId("simulation")).toHaveTextContent("none"));
  });

  it("clears the previous alternatives when a new simulation starts", async () => {
    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("twin")).toHaveTextContent("alex"));

    await user.click(screen.getByText("sim"));
    await waitFor(() => expect(screen.getByTestId("simulation")).not.toHaveTextContent("none"));
    await user.click(screen.getByText("opt"));
    await waitFor(() => expect(screen.getByTestId("optimization")).toHaveTextContent("some"));

    await user.click(screen.getByText("sim"));
    await waitFor(() => expect(screen.getByTestId("optimization")).toHaveTextContent("none"));
  });

  it("does not let an older simulation overwrite a newer one", async () => {
    const user = userEvent.setup();
    let releaseSlow: (v: { data: SimulationResponse; source: "api" }) => void = () => {};
    const slow = new Promise<{ data: SimulationResponse; source: "api" }>((resolve) => {
      releaseSlow = resolve;
    });
    const fast = { data: { ...SIMULATION, simulation_id: "newer" }, source: "api" as const };

    vi.mocked(api.runSimulation).mockReturnValueOnce(slow).mockResolvedValueOnce(fast);

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("twin")).toHaveTextContent("alex"));

    await user.click(screen.getByText("sim")); // starts the slow one
    await user.click(screen.getByText("sim")); // starts and finishes the fast one
    await waitFor(() => expect(screen.getByTestId("simulation")).toHaveTextContent("newer"));

    // The stale response lands last and must be ignored.
    releaseSlow({ data: { ...SIMULATION, simulation_id: "older" }, source: "api" });
    await waitFor(() => expect(screen.getByTestId("simulation")).toHaveTextContent("newer"));
    expect(screen.getByTestId("simulation")).not.toHaveTextContent("older");
  });
});

describe("useTwin", () => {
  it("throws outside the provider rather than returning an empty twin", () => {
    // React logs the thrown error; silence it for this one assertion.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used inside a TwinProvider/);
    spy.mockRestore();
  });
});

/**
 * The goal flow and the waiting state, which the probe above does not reach.
 * A second probe rather than a wider one: these tests are about which control
 * is saving and what survives a rejected save.
 */
function GoalProbe() {
  const t = useTwin();
  return (
    <div>
      <span data-testid="twin-goals">{t.twin ? t.twin.goals.length : "none"}</span>
      <span data-testid="draft">{t.goalDraft ? t.goalDraft.text : "none"}</span>
      <span data-testid="compile-error">{t.goalCompileError ?? "none"}</span>
      <span data-testid="save-error">{t.goalSaveError ?? "none"}</span>
      <span data-testid="update-error">{t.twinUpdateError ?? "none"}</span>
      <span data-testid="composer-key">{t.composerKey}</span>
      <span data-testid="busy">{t.isBusy ? "yes" : "no"}</span>
      <span data-testid="scope">{t.savingScope ?? "none"}</span>
      <span data-testid="compiling">{t.isCompilingGoal ? "yes" : "no"}</span>
      <span data-testid="simulation-2">{t.simulation ? t.simulation.simulation_id : "none"}</span>
      <button onClick={() => void t.compileGoalText("I need $900 for a bike")}>compile</button>
      <button onClick={() => void t.confirmGoals({ goals: [], constraints: [] })}>confirm</button>
      <button onClick={() => t.removeGoal("goal_summer_housing")}>remove</button>
      <button onClick={() => t.discardGoalDraft()}>discard</button>
      <button onClick={() => t.answerClarification("obl_mystery_transfer", "savings_transfer")}>
        answer
      </button>
      <button onClick={() => void t.simulate({ ...SIMULATION.request.events[0] })}>sim2</button>
    </div>
  );
}

const DRAFT = {
  user_id: "alex",
  text: "I need $900 for a bike",
  goals: [],
  constraints: [],
  clarifications: [],
  unparsed: [],
  compiler: "rules" as const,
};

function renderGoalProbe() {
  return render(
    <TwinProvider>
      <GoalProbe />
    </TwinProvider>,
  );
}

async function loaded() {
  const user = userEvent.setup();
  renderGoalProbe();
  await waitFor(() => expect(screen.getByTestId("twin-goals")).not.toHaveTextContent("none"));
  return user;
}

describe("TwinProvider goals", () => {
  beforeEach(() => {
    // These tests count calls, so they need the counts from the block above
    // cleared. The implementations are re-established here for the same reason.
    vi.clearAllMocks();
    vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
    vi.mocked(api.runSimulation).mockResolvedValue({ data: SIMULATION, source: "api" });
    vi.mocked(api.runOptimization).mockResolvedValue({
      data: { user_id: "alex", candidates: [] } as never,
      source: "api",
    });
    vi.mocked(api.compileGoal).mockResolvedValue({ data: DRAFT, source: "api" });
    vi.mocked(api.saveGoals).mockResolvedValue({ data: { ...TWIN, goals: [] }, source: "api" });
    vi.mocked(api.respondToClarification).mockResolvedValue({ data: TWIN, source: "api" });
  });

  it("holds the compiled draft without touching the twin", async () => {
    const user = await loaded();
    await user.click(screen.getByText("compile"));
    await waitFor(() => expect(screen.getByTestId("draft")).toHaveTextContent("bike"));
    expect(api.saveGoals).not.toHaveBeenCalled();
    expect(screen.getByTestId("twin-goals")).toHaveTextContent("1");
  });

  // There is no local parser: a guessed amount is exactly what the compiler refuses
  // to invent, so a failure must leave no draft at all.
  it("drafts nothing when the compiler cannot be reached", async () => {
    vi.mocked(api.compileGoal).mockRejectedValue(new Error("compiler down"));
    const user = await loaded();
    await user.click(screen.getByText("compile"));
    await waitFor(() =>
      expect(screen.getByTestId("compile-error")).toHaveTextContent("compiler down"),
    );
    expect(screen.getByTestId("draft")).toHaveTextContent("none");
    expect(screen.getByTestId("compiling")).toHaveTextContent("no");
  });

  it("clears an earlier failure when the text is read again", async () => {
    vi.mocked(api.compileGoal).mockRejectedValueOnce(new Error("compiler down"));
    const user = await loaded();
    await user.click(screen.getByText("compile"));
    await waitFor(() => expect(screen.getByTestId("compile-error")).toHaveTextContent("down"));

    await user.click(screen.getByText("compile"));
    await waitFor(() => expect(screen.getByTestId("draft")).toHaveTextContent("bike"));
    expect(screen.getByTestId("compile-error")).toHaveTextContent("none");
  });

  it("drops the draft and resets the composer once the save succeeds", async () => {
    const user = await loaded();
    await user.click(screen.getByText("compile"));
    await waitFor(() => expect(screen.getByTestId("draft")).toHaveTextContent("bike"));
    const key = screen.getByTestId("composer-key").textContent;

    await user.click(screen.getByText("confirm"));
    await waitFor(() => expect(screen.getByTestId("draft")).toHaveTextContent("none"));
    expect(screen.getByTestId("composer-key")).not.toHaveTextContent(key!);
  });

  // A rejected save must not cost Alex the text he typed.
  it("keeps the draft on screen when the save is rejected", async () => {
    vi.mocked(api.saveGoals).mockRejectedValue(new Error("Goal ids must be unique"));
    const user = await loaded();
    await user.click(screen.getByText("compile"));
    await waitFor(() => expect(screen.getByTestId("draft")).toHaveTextContent("bike"));

    await user.click(screen.getByText("confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("save-error")).toHaveTextContent("Goal ids must be unique"),
    );
    expect(screen.getByTestId("draft")).toHaveTextContent("bike");
  });

  // The error belongs next to the control that caused it, not in the page banner.
  it("reports a failed goal save on the composer, not as a general twin error", async () => {
    vi.mocked(api.saveGoals).mockRejectedValue(new Error("rejected"));
    const user = await loaded();
    await user.click(screen.getByText("confirm"));
    await waitFor(() => expect(screen.getByTestId("save-error")).toHaveTextContent("rejected"));
    expect(screen.getByTestId("update-error")).toHaveTextContent("none");
  });

  it("discards a draft without saving anything", async () => {
    const user = await loaded();
    await user.click(screen.getByText("compile"));
    await waitFor(() => expect(screen.getByTestId("draft")).toHaveTextContent("bike"));

    await user.click(screen.getByText("discard"));
    expect(screen.getByTestId("draft")).toHaveTextContent("none");
    expect(api.saveGoals).not.toHaveBeenCalled();
  });

  // The PUT replaces the whole declared set, so removal has to send everything else.
  it("removes a goal by saving the set without it", async () => {
    const user = await loaded();
    await user.click(screen.getByText("remove"));
    await waitFor(() => expect(api.saveGoals).toHaveBeenCalledTimes(1));

    const [, request] = vi.mocked(api.saveGoals).mock.calls[0];
    expect(request.goals).toEqual([]);
    expect(request.constraints).toEqual(TWIN.constraints);
  });

  it("names the goal being removed as the saving control", async () => {
    let release: (v: { data: FinancialTwin; source: "api" }) => void = () => {};
    vi.mocked(api.saveGoals).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const user = await loaded();
    await user.click(screen.getByText("remove"));

    await waitFor(() =>
      expect(screen.getByTestId("scope")).toHaveTextContent("goal_summer_housing"),
    );
    expect(screen.getByTestId("busy")).toHaveTextContent("yes");

    release({ data: TWIN, source: "api" });
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent("no"));
    expect(screen.getByTestId("scope")).toHaveTextContent("none");
  });

  it("names the obligation being answered as the saving control", async () => {
    let release: (v: { data: FinancialTwin; source: "api" }) => void = () => {};
    vi.mocked(api.respondToClarification).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const user = await loaded();
    await user.click(screen.getByText("answer"));

    await waitFor(() =>
      expect(screen.getByTestId("scope")).toHaveTextContent("obl_mystery_transfer"),
    );
    release({ data: TWIN, source: "api" });
    await waitFor(() => expect(screen.getByTestId("scope")).toHaveTextContent("none"));
  });

  it("carries Alex's answer to the backend with the twin it applies to", async () => {
    const user = await loaded();
    await user.click(screen.getByText("answer"));
    await waitFor(() => expect(api.respondToClarification).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.respondToClarification).mock.calls[0][1]).toEqual({
      user_id: "alex",
      obligation_id: "obl_mystery_transfer",
      category: "savings_transfer",
    });
  });

  // A twin that did not change cannot make a simulation stale.
  it("keeps the simulation when the twin update fails", async () => {
    vi.mocked(api.respondToClarification).mockRejectedValue(new Error("nope"));
    const user = await loaded();
    await user.click(screen.getByText("sim2"));
    await waitFor(() =>
      expect(screen.getByTestId("simulation-2")).toHaveTextContent(SIMULATION.simulation_id),
    );

    await user.click(screen.getByText("answer"));
    await waitFor(() => expect(screen.getByTestId("update-error")).toHaveTextContent("nope"));
    expect(screen.getByTestId("simulation-2")).toHaveTextContent(SIMULATION.simulation_id);
  });

  it("asks for no alternatives when there is no simulation to improve on", async () => {
    const user = await loaded();
    await user.click(screen.getByText("sim2"));
    await waitFor(() => expect(screen.getByTestId("simulation-2")).not.toHaveTextContent("none"));

    await user.click(screen.getByText("answer"));
    await waitFor(() => expect(screen.getByTestId("simulation-2")).toHaveTextContent("none"));
    expect(api.runOptimization).not.toHaveBeenCalled();
  });
});
