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
    setMinimumBalance: vi.fn(),
    commitPurchase: vi.fn(),
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
      <span data-testid="offline">{t.isOffline ? "yes" : "no"}</span>
      <span data-testid="error">{t.twinError ?? "none"}</span>
      <span data-testid="simulation">{t.simulation ? t.simulation.simulation_id : "none"}</span>
      <span data-testid="optimization">{t.optimization ? "some" : "none"}</span>
      <span data-testid="name">{t.twin?.display_name ?? "none"}</span>
      <span data-testid="stale">{t.planChanged ? "stale" : "current"}</span>
      <span data-testid="commit-result">{t.commitResult ?? "none"}</span>
      <span data-testid="commit-error">{t.commitError ?? "none"}</span>
      <button onClick={() => void t.simulate({ ...SIMULATION.request.events[0] })}>sim</button>
      <button onClick={() => t.setMinimum(300)}>min</button>
      <button onClick={() => void t.optimize()}>opt</button>
      <button onClick={() => void t.commit([{ ...SIMULATION.request.events[0] }])}>commit</button>
      {/* `refreshTwin` rejects to its caller, exactly as the Obligations page handles it. */}
      <button onClick={() => t.refreshTwin().catch(() => {})}>refresh</button>
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
  vi.clearAllMocks();
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
    expect(screen.getByTestId("offline")).toHaveTextContent("yes");
  });

  it("blocks result calls and writes when the loaded twin is offline", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "fixture" });
    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("offline")).toHaveTextContent("yes"));

    await user.click(screen.getByText("sim"));
    await user.click(screen.getByText("min"));

    expect(api.runSimulation).not.toHaveBeenCalled();
    expect(api.setMinimumBalance).not.toHaveBeenCalled();
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
 * The write path, which the probe above does not reach: which control reports
 * itself as saving, and what a write does to the simulation built on the twin
 * it replaced. `setMinimum` is the vehicle — every write shares `updateTwin`.
 */
function WriteProbe() {
  const t = useTwin();
  return (
    <div>
      <span data-testid="constraints">{t.twin ? t.twin.constraints.length : "none"}</span>
      <span data-testid="update-error">{t.twinUpdateError ?? "none"}</span>
      <span data-testid="busy">{t.isBusy ? "yes" : "no"}</span>
      <span data-testid="scope">{t.savingScope ?? "none"}</span>
      <span data-testid="simulation-2">{t.simulation ? t.simulation.simulation_id : "none"}</span>
      <button onClick={() => t.setMinimum(400)}>minimum</button>
      <button onClick={() => void t.simulate({ ...SIMULATION.request.events[0] })}>sim2</button>
    </div>
  );
}

async function loadedWriteProbe() {
  const user = userEvent.setup();
  render(
    <TwinProvider>
      <WriteProbe />
    </TwinProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("constraints")).not.toHaveTextContent("none"));
  return user;
}

describe("TwinProvider writes", () => {
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
    vi.mocked(api.setMinimumBalance).mockResolvedValue({ data: TWIN, source: "api" });
  });

  it("carries the declared amount to the backend", async () => {
    const user = await loadedWriteProbe();
    await user.click(screen.getByText("minimum"));
    await waitFor(() => expect(api.setMinimumBalance).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.setMinimumBalance).mock.calls[0][1]).toEqual({ amount: 400 });
  });

  it("names the control that is saving, and clears it when the write lands", async () => {
    let release: (v: { data: FinancialTwin; source: "api" }) => void = () => {};
    vi.mocked(api.setMinimumBalance).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const user = await loadedWriteProbe();
    await user.click(screen.getByText("minimum"));

    await waitFor(() => expect(screen.getByTestId("scope")).toHaveTextContent("minimum-balance"));
    expect(screen.getByTestId("busy")).toHaveTextContent("yes");

    release({ data: TWIN, source: "api" });
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent("no"));
    expect(screen.getByTestId("scope")).toHaveTextContent("none");
  });

  // A twin that did not change cannot make a simulation stale.
  it("keeps the simulation when the twin update fails", async () => {
    vi.mocked(api.setMinimumBalance).mockRejectedValue(new Error("nope"));
    const user = await loadedWriteProbe();
    await user.click(screen.getByText("sim2"));
    await waitFor(() =>
      expect(screen.getByTestId("simulation-2")).toHaveTextContent(SIMULATION.simulation_id),
    );

    await user.click(screen.getByText("minimum"));
    await waitFor(() => expect(screen.getByTestId("update-error")).toHaveTextContent("nope"));
    expect(screen.getByTestId("simulation-2")).toHaveTextContent(SIMULATION.simulation_id);
  });

  it("asks for no alternatives when there is no simulation to improve on", async () => {
    const user = await loadedWriteProbe();
    await user.click(screen.getByText("sim2"));
    await waitFor(() => expect(screen.getByTestId("simulation-2")).not.toHaveTextContent("none"));

    await user.click(screen.getByText("minimum"));
    await waitFor(() => expect(screen.getByTestId("simulation-2")).toHaveTextContent("none"));
    expect(api.runOptimization).not.toHaveBeenCalled();
  });
});


describe("TwinProvider refreshTwin", () => {
  /** What the Obligations page calls after a 404/409 stale write (G-16). */
  const RELOADED = { ...TWIN, display_name: "Alex reloaded" } as FinancialTwin;

  it("replaces the canonical twin and its source", async () => {
    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("twin")).toHaveTextContent("alex"));
    vi.mocked(api.getTwin).mockResolvedValue({ data: RELOADED, source: "api" });

    await user.click(screen.getByText("refresh"));

    await waitFor(() => expect(screen.getByTestId("name")).toHaveTextContent("Alex reloaded"));
    expect(screen.getByTestId("source")).toHaveTextContent("api");
    expect(api.getTwin).toHaveBeenCalledTimes(2);
  });

  it("clears the simulation and alternatives built on the twin it replaced", async () => {
    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("twin")).toHaveTextContent("alex"));

    await user.click(screen.getByText("sim"));
    await waitFor(() => expect(screen.getByTestId("simulation")).not.toHaveTextContent("none"));
    await user.click(screen.getByText("opt"));
    await waitFor(() => expect(screen.getByTestId("optimization")).toHaveTextContent("some"));

    await user.click(screen.getByText("refresh"));

    await waitFor(() => expect(screen.getByTestId("simulation")).toHaveTextContent("none"));
    expect(screen.getByTestId("optimization")).toHaveTextContent("none");
  });

  it("goes offline when the reload can only reach the fixture", async () => {
    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("offline")).toHaveTextContent("no"));
    vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "fixture" });

    await user.click(screen.getByText("refresh"));

    await waitFor(() => expect(screen.getByTestId("offline")).toHaveTextContent("yes"));
  });

  it("rejects to its caller rather than blanking the twin on screen", async () => {
    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("twin")).toHaveTextContent("alex"));
    vi.mocked(api.getTwin).mockRejectedValue(new Error("still down"));

    await user.click(screen.getByText("refresh"));

    await waitFor(() => expect(api.getTwin).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("twin")).toHaveTextContent("alex");
  });
});

describe("TwinProvider commits", () => {
  async function ready() {
    const user = userEvent.setup();
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("twin")).toHaveTextContent("alex"));
    return user;
  }

  // API-2: the write route answers with the whole twin, so nothing re-reads it.
  it("takes the twin from the commit response and marks the comparison stale", async () => {
    vi.mocked(api.commitPurchase).mockResolvedValue({
      twin: { ...TWIN, user_id: "alex-after" },
      created_ids: ["one_purchase_abc1234567"],
      already_committed: false,
    });
    const user = await ready();
    const reads = vi.mocked(api.getTwin).mock.calls.length;
    await user.click(screen.getByText("commit"));

    await waitFor(() => expect(screen.getByTestId("twin")).toHaveTextContent("alex-after"));
    expect(screen.getByTestId("stale")).toHaveTextContent("stale");
    expect(screen.getByTestId("commit-result")).toHaveTextContent("Added to your plan");
    expect(vi.mocked(api.getTwin).mock.calls).toHaveLength(reads);
  });

  // G-15: the second press of a double-click gets the same record back.
  it("says a repeated commit changed nothing", async () => {
    vi.mocked(api.commitPurchase).mockResolvedValue({
      twin: TWIN,
      created_ids: ["one_purchase_abc1234567"],
      already_committed: true,
    });
    const user = await ready();
    await user.click(screen.getByText("commit"));
    await waitFor(() =>
      expect(screen.getByTestId("commit-result")).toHaveTextContent(
        "That purchase was already in your plan.",
      ),
    );
  });

  // G-16
  it("asks the reader to look again when the plan moved under them", async () => {
    vi.mocked(api.commitPurchase).mockRejectedValue(new api.ApiError("stale deadline", 409));
    const user = await ready();
    const reads = vi.mocked(api.getTwin).mock.calls.length;
    await user.click(screen.getByText("commit"));

    await waitFor(() =>
      expect(screen.getByTestId("commit-error")).toHaveTextContent(
        "That changed. Please review and try again.",
      ),
    );
    // The twin is re-read, because whatever moved is in it.
    expect(vi.mocked(api.getTwin).mock.calls).toHaveLength(reads + 1);
    expect(screen.getByTestId("stale")).toHaveTextContent("current");
  });

  it("shows any other failure in the backend's own words", async () => {
    vi.mocked(api.commitPurchase).mockRejectedValue(new Error("Unknown account_id 'acc_nope'"));
    const user = await ready();
    await user.click(screen.getByText("commit"));
    await waitFor(() =>
      expect(screen.getByTestId("commit-error")).toHaveTextContent("Unknown account_id"),
    );
  });

  // CM-6: the next run is against the plan as it now stands.
  it("clears the stale mark and the notice on the next simulation", async () => {
    vi.mocked(api.commitPurchase).mockResolvedValue({ twin: TWIN, already_committed: false });
    const user = await ready();
    await user.click(screen.getByText("commit"));
    await waitFor(() => expect(screen.getByTestId("stale")).toHaveTextContent("stale"));

    await user.click(screen.getByText("sim"));
    await waitFor(() => expect(screen.getByTestId("stale")).toHaveTextContent("current"));
    expect(screen.getByTestId("commit-result")).toHaveTextContent("none");
  });
});
