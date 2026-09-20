import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialTwin, OptimizationResponse, SimulationResponse } from "@/lib/types";
import mockSimulation from "@/lib/mock/simulation.json";
import mockTwin from "@/lib/mock/twin.json";

/** The query string the page is visited with; a what-if arrives through it (PL-6). */
let query = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(query) }));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getTwin: vi.fn(),
    runSimulation: vi.fn(),
    runOptimization: vi.fn(),
  };
});

import * as api from "@/lib/api";
import { TwinProvider } from "@/lib/state/TwinProvider";
import SimulatePage from "./page";

const TWIN = mockTwin as unknown as FinancialTwin;
const SIMULATION = mockSimulation as unknown as SimulationResponse;
// A real-shaped response with nothing to suggest: the panel still renders its
// summary and assumptions, so every required field has to be present.
const NO_OPTIONS: OptimizationResponse = {
  optimization_id: "opt-1",
  user_id: "alex",
  request: { user_id: "alex", events: SIMULATION.request.events },
  horizon_end: SIMULATION.horizon_end,
  baseline: SIMULATION.baseline,
  candidates: [],
  recommended_id: null,
  summary: "No lower-impact alternative was found.",
  assumptions: ["Spending follows the observed averages."],
  num_simulations: SIMULATION.num_simulations ?? 1000,
};

function renderSimulate() {
  return render(
    <TwinProvider>
      <SimulatePage />
    </TwinProvider>,
  );
}

async function simulate() {
  const user = userEvent.setup();
  renderSimulate();
  await waitFor(() => expect(screen.getByRole("button", { name: /Simulate/ })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: /Simulate/ }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  query = "";
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.runSimulation).mockResolvedValue({ data: SIMULATION, source: "api" });
  vi.mocked(api.runOptimization).mockResolvedValue({ data: NO_OPTIONS, source: "api" });
});

describe("Purchase Simulator", () => {
  it("prompts for a simulation before one exists", async () => {
    renderSimulate();
    await waitFor(() => expect(screen.getByText(/to compare the future/)).toBeInTheDocument());
  });

  it("carries the purchase form the Overview no longer has", async () => {
    renderSimulate();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Simulate/ })).toBeInTheDocument(),
    );
  });

  it("pairs baseline against counterfactual once a simulation returns", async () => {
    await simulate();
    await waitFor(() => expect(screen.getByText("Why?")).toBeInTheDocument());
    expect(api.runSimulation).toHaveBeenCalledTimes(1);
  });

  it("links on to the detailed trajectory after a success", async () => {
    await simulate();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /balance trajectory/i })).toHaveAttribute(
        "href",
        "/trajectory",
      ),
    );
  });

  it("asks for alternatives on its own, with no button to press", async () => {
    await simulate();
    await waitFor(() => expect(api.runOptimization).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("button", { name: /Compare other ways/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the backend's error instead of fixture numbers", async () => {
    vi.mocked(api.runSimulation).mockRejectedValue(new Error("horizon too long"));
    await simulate();
    await waitFor(() => expect(screen.getByText("Simulation failed")).toBeInTheDocument());
    expect(screen.getByText("horizon too long")).toBeInTheDocument();
    expect(screen.queryByText("Why?")).not.toBeInTheDocument();
  });

  it("does not optimize against the saved offline example", async () => {
    vi.mocked(api.runSimulation).mockResolvedValue({ data: SIMULATION, source: "fixture" });
    await simulate();
    await waitFor(() => expect(screen.getByText("Backend offline")).toBeInTheDocument());
    expect(api.runOptimization).not.toHaveBeenCalled();
  });

  it("offers a retry, not a silent failure, when alternatives are rejected", async () => {
    vi.mocked(api.runOptimization).mockRejectedValue(new Error("optimizer down"));
    await simulate();
    await waitFor(() => expect(screen.getByText(/optimizer down/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("a what-if the Assistant routed here (PL-6)", () => {
  it("fills the form and waits, rather than running the simulation", async () => {
    query = "description=Bike&amount=450&date=2026-10-01";
    renderSimulate();

    await waitFor(() => expect(screen.getByLabelText("What")).toHaveValue("Bike"));
    expect(screen.getByLabelText("Amount (USD)")).toHaveValue(450);
    expect(screen.getByLabelText("When")).toHaveValue("2026-10-01");
    // AS-8: the Assistant hands the purchase over; the user still presses Simulate.
    expect(api.runSimulation).not.toHaveBeenCalled();
  });

  it("keeps its defaults when the link carries nothing usable", async () => {
    query = "amount=free";
    renderSimulate();

    await waitFor(() => expect(screen.getByLabelText("What")).toHaveValue("Laptop"));
    expect(screen.getByLabelText("Amount (USD)")).toHaveValue(800);
    expect(api.runSimulation).not.toHaveBeenCalled();
  });
});
