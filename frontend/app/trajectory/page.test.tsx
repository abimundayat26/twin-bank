import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialTwin, SimulationResponse } from "@/lib/types";
import mockSimulation from "@/lib/mock/simulation.json";
import mockTwin from "@/lib/mock/twin.json";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getTwin: vi.fn(),
    runSimulation: vi.fn(),
    runOptimization: vi.fn(),
    getExplanation: vi.fn(),
    setMinimumBalance: vi.fn(),
  };
});

import * as api from "@/lib/api";
import { TwinProvider, useTwin } from "@/lib/state/TwinProvider";
import SimulatePage from "../simulate/page";
import TrajectoryPage, { SIMULATION_ID_KEY } from "./page";

const TWIN = mockTwin as unknown as FinancialTwin;
const SIMULATION = mockSimulation as unknown as SimulationResponse;

/**
 * An edit to a declared fact, without rendering the page that owns the form.
 * The provider's reaction is what matters here, not any particular control.
 */
function ChangeTwin() {
  const { setMinimum } = useTwin();
  return (
    <button type="button" onClick={() => setMinimum(400)}>
      Change the twin
    </button>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.runSimulation).mockResolvedValue({ data: SIMULATION, source: "api" });
  vi.mocked(api.runOptimization).mockRejectedValue(new Error("not under test"));
  vi.mocked(api.getExplanation).mockRejectedValue(new api.ApiError("Not found", 404));
  window.sessionStorage.clear();
});

describe("Balance Trajectory", () => {
  it("explains what belongs here and links back when nothing has been simulated", async () => {
    render(
      <TwinProvider>
        <TrajectoryPage />
      </TwinProvider>,
    );
    expect(await screen.findByText("No projection yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Purchase Simulator/ })).toHaveAttribute(
      "href",
      "/simulate",
    );
  });

  /**
   * The point of the provider: a simulation run on one route is still there on
   * the next one (SPEC section 9). Both pages share a provider here, which is
   * what navigating between them does.
   */
  it("shows the simulation that was run on the simulator page", async () => {
    const user = userEvent.setup();
    render(
      <TwinProvider>
        <SimulatePage />
        <TrajectoryPage />
      </TwinProvider>,
    );

    expect(await screen.findByText("No projection yet")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole("button", { name: /Simulate/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Simulate/ }));

    await waitFor(() =>
      expect(screen.queryByText("No projection yet")).not.toBeInTheDocument(),
    );
    expect(screen.getAllByRole("img").length).toBeGreaterThan(0);
  });

  // TR-6: the assumptions block and the narrative footer are gone; the text
  // equivalent of the chart is what carries the numbers in words now (G-19).
  it("shows the chart and its data table, and no assumptions block", async () => {
    const user = userEvent.setup();
    render(
      <TwinProvider>
        <SimulatePage />
        <TrajectoryPage />
      </TwinProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /Simulate/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Simulate/ }));

    await waitFor(() => expect(screen.getAllByRole("table").length).toBeGreaterThan(0));
    expect(screen.queryByText("What this projection assumed")).not.toBeInTheDocument();
    expect(screen.queryByText(/middle 80% of simulated futures/)).not.toBeInTheDocument();
    expect(screen.queryByText(/measured mid-day/)).not.toBeInTheDocument();
  });

  it("says plainly when it is showing the saved offline example", async () => {
    vi.mocked(api.runSimulation).mockResolvedValue({ data: SIMULATION, source: "fixture" });
    const user = userEvent.setup();
    render(
      <TwinProvider>
        <SimulatePage />
        <TrajectoryPage />
      </TwinProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /Simulate/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Simulate/ }));

    await waitFor(() =>
      expect(screen.getAllByText("Backend offline").length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/not your purchase/)).toBeInTheDocument();
  });

  /**
   * TR-1's reload path. A reload empties the provider, so the page has to ask
   * the backend for the id it kept. These render the page on its own, which is
   * what a cold load of /trajectory is.
   */
  describe("after a reload", () => {
    it("remembers the simulation on screen so a reload can ask for it again", async () => {
      const user = userEvent.setup();
      render(
        <TwinProvider>
          <SimulatePage />
          <TrajectoryPage />
        </TwinProvider>,
      );
      await waitFor(() => expect(screen.getByRole("button", { name: /Simulate/ })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: /Simulate/ }));

      await waitFor(() =>
        expect(window.sessionStorage.getItem(SIMULATION_ID_KEY)).toBe(SIMULATION.simulation_id),
      );
    });

    it("refetches the stored simulation and draws it", async () => {
      window.sessionStorage.setItem(SIMULATION_ID_KEY, SIMULATION.simulation_id);
      vi.mocked(api.getExplanation).mockResolvedValue({ data: SIMULATION, source: "api" });

      render(
        <TwinProvider>
          <TrajectoryPage />
        </TwinProvider>,
      );

      await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
      expect(api.getExplanation).toHaveBeenCalledWith(SIMULATION.simulation_id);
      expect(screen.queryByText("No projection yet")).not.toBeInTheDocument();
    });

    // The backend keeps results in memory, so an id from before a restart is
    // gone. Nothing to show is the empty state, not an error.
    it("falls back to the empty state when the id is a 404", async () => {
      window.sessionStorage.setItem(SIMULATION_ID_KEY, "expired-id");
      vi.mocked(api.getExplanation).mockRejectedValue(new api.ApiError("Not found", 404));

      render(
        <TwinProvider>
          <TrajectoryPage />
        </TwinProvider>,
      );

      expect(await screen.findByText("No projection yet")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    // G-9: any other failure is the backend's own words, with a way to try again.
    it("shows the backend's message with Retry when the refetch fails otherwise", async () => {
      window.sessionStorage.setItem(SIMULATION_ID_KEY, SIMULATION.simulation_id);
      vi.mocked(api.getExplanation).mockRejectedValue(
        new api.ApiError("Simulation store unavailable", 503),
      );

      render(
        <TwinProvider>
          <TrajectoryPage />
        </TwinProvider>,
      );

      expect(await screen.findByText("Simulation store unavailable")).toBeInTheDocument();

      vi.mocked(api.getExplanation).mockResolvedValue({ data: SIMULATION, source: "api" });
      await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
    });

    it("asks for nothing when no id was stored", async () => {
      render(
        <TwinProvider>
          <TrajectoryPage />
        </TwinProvider>,
      );
      expect(await screen.findByText("No projection yet")).toBeInTheDocument();
      expect(api.getExplanation).not.toHaveBeenCalled();
    });
  });

  /**
   * The provider drops its simulation for three different reasons, and only one
   * of them is a reload. A discard is deliberate: the stored id still names the
   * result, but the result is no longer something this page may draw.
   */
  describe("when the provider discards the simulation", () => {
    // G-9 and G-14: a failed run shows the error and no numbers. Restoring the
    // previous projection here would be the silent fallback G-14 forbids.
    it("shows no projection after a simulation fails", async () => {
      const user = userEvent.setup();
      render(
        <TwinProvider>
          <SimulatePage />
          <TrajectoryPage />
        </TwinProvider>,
      );
      await waitFor(() => expect(screen.getByRole("button", { name: /Simulate/ })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: /Simulate/ }));
      // Two charts: the Simulator's own preview, and the Trajectory page's.
      await waitFor(() => expect(screen.getAllByRole("img").length).toBeGreaterThan(0));

      // The second run is rejected, so the first result is no longer current.
      vi.mocked(api.runSimulation).mockRejectedValue(
        new api.ApiError("Purchase date is after the simulation horizon", 422),
      );
      await user.click(screen.getByRole("button", { name: /Simulate/ }));

      await waitFor(() => expect(screen.getByText("No projection yet")).toBeInTheDocument());
      expect(screen.queryAllByRole("img")).toHaveLength(0);
      expect(api.getExplanation).not.toHaveBeenCalled();
    });

    // The old projection was computed from a twin that no longer exists, and the
    // reserve line and goal marker around it would come from the twin that does.
    it("shows no projection after the twin changes", async () => {
      const user = userEvent.setup();
      vi.mocked(api.setMinimumBalance).mockResolvedValue({
        data: { ...TWIN, as_of: "2026-09-20" } as FinancialTwin,
        source: "api",
      });

      render(
        <TwinProvider>
          <SimulatePage />
          <TrajectoryPage />
          <ChangeTwin />
        </TwinProvider>,
      );
      await waitFor(() => expect(screen.getByRole("button", { name: /Simulate/ })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: /Simulate/ }));
      await waitFor(() => expect(screen.getAllByRole("img").length).toBeGreaterThan(0));

      await user.click(screen.getByRole("button", { name: "Change the twin" }));

      await waitFor(() => expect(screen.getByText("No projection yet")).toBeInTheDocument());
      expect(screen.queryAllByRole("img")).toHaveLength(0);
      expect(api.getExplanation).not.toHaveBeenCalled();
    });

    // Otherwise the next reload resurrects it: the same bug, one step later.
    it("forgets the id, so a later reload cannot restore it either", async () => {
      const user = userEvent.setup();
      render(
        <TwinProvider>
          <SimulatePage />
          <TrajectoryPage />
        </TwinProvider>,
      );
      await waitFor(() => expect(screen.getByRole("button", { name: /Simulate/ })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: /Simulate/ }));
      await waitFor(() =>
        expect(window.sessionStorage.getItem(SIMULATION_ID_KEY)).toBe(SIMULATION.simulation_id),
      );

      vi.mocked(api.runSimulation).mockRejectedValue(new api.ApiError("Rejected", 422));
      await user.click(screen.getByRole("button", { name: /Simulate/ }));

      await waitFor(() => expect(window.sessionStorage.getItem(SIMULATION_ID_KEY)).toBeNull());
    });
  });
});
