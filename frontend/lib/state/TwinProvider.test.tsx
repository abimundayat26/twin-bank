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
