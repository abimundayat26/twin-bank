import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialTwin, SimulationResponse } from "@/lib/types";
import mockSimulation from "@/lib/mock/simulation.json";
import mockTwin from "@/lib/mock/twin.json";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, getTwin: vi.fn(), runSimulation: vi.fn(), runOptimization: vi.fn() };
});

import * as api from "@/lib/api";
import { TwinProvider } from "@/lib/state/TwinProvider";
import SimulatePage from "../simulate/page";
import TrajectoryPage from "./page";

const TWIN = mockTwin as unknown as FinancialTwin;
const SIMULATION = mockSimulation as unknown as SimulationResponse;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.runSimulation).mockResolvedValue({ data: SIMULATION, source: "api" });
  vi.mocked(api.runOptimization).mockRejectedValue(new Error("not under test"));
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
    expect(screen.getByText("What this projection assumed")).toBeInTheDocument();
  });

  it("states the horizon, the number of paths and the reserve it drew", async () => {
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
      expect(screen.getByText("What this projection assumed")).toBeInTheDocument(),
    );
    expect(screen.getByText("Horizon")).toBeInTheDocument();
    expect(screen.getByText("Monte Carlo paths")).toBeInTheDocument();
    expect(screen.getByText("Emergency reserve")).toBeInTheDocument();
  });

  it("states the default checking threshold behind its low-balance risk", async () => {
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
      expect(screen.getByText("What this projection assumed")).toBeInTheDocument(),
    );
    expect(screen.getByText("Low-balance line")).toBeInTheDocument();
    expect(screen.getByText(/Simulator default; Alex has not set/)).toBeInTheDocument();
  });

  it("explains the uncertainty band in words, not only as a shape", async () => {
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
      expect(screen.getByText(/middle 80% of simulated futures/)).toBeInTheDocument(),
    );
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
});
