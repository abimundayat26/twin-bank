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

const COMPROMISE_OPTIONS: OptimizationResponse = {
  ...NO_OPTIONS,
  candidates: [
    {
      id: "cand_buy_now",
      kind: "buy_now",
      label: "Buy now",
      detail: "Buy the laptop as entered.",
      events: SIMULATION.request.events,
      spending_adjustments: [],
      metrics: SIMULATION.counterfactual,
      meets_constraints: false,
      violations: ["Dips below the reserve"],
    },
    {
      id: "cand_delay",
      kind: "delay",
      label: "Wait one month",
      detail: "Wait one month before buying.",
      events: [{ ...SIMULATION.request.events[0], date: "2026-10-19" }],
      spending_adjustments: [],
      metrics: SIMULATION.counterfactual,
      meets_constraints: true,
      violations: [],
    },
    {
      id: "cand_savings",
      kind: "from_savings",
      label: "Pay from savings",
      detail: "Pay for the laptop from savings.",
      events: [{ ...SIMULATION.request.events[0], account_id: "acc_savings" }],
      spending_adjustments: [],
      metrics: SIMULATION.counterfactual,
      meets_constraints: true,
      violations: [],
    },
  ],
  recommended_id: "cand_delay",
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

  it("pairs No Purchase against Purchase once a simulation returns", async () => {
    await simulate();
    await waitFor(() => expect(screen.getByText("No Purchase")).toBeInTheDocument());
    expect(screen.getByText("Purchase")).toBeInTheDocument();
    expect(api.runSimulation).toHaveBeenCalledTimes(1);
  });

  // SM-6: the backend still returns them; this page does not show them.
  it("shows no explanation, drivers or assumptions", async () => {
    await simulate();
    await waitFor(() => expect(screen.getByText("No Purchase")).toBeInTheDocument());
    expect(screen.queryByText("Why?")).not.toBeInTheDocument();
    expect(screen.queryByText(/What this assumes/i)).not.toBeInTheDocument();
  });

  // SM-8
  it("keeps the trajectory closed until it is asked for", async () => {
    await simulate();
    const preview = await screen.findByText("Balance over the next 90 days");
    expect(preview.closest("details")).not.toHaveAttribute("open");
  });

  it("asks for alternatives on its own, with no button to press", async () => {
    await simulate();
    await waitFor(() => expect(api.runOptimization).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("button", { name: /Compare other ways/ }),
    ).not.toBeInTheDocument();
  });

  // SM-12 / SM-13: an asynchronously discovered action belongs after its row.
  it("places Apply Compromise below the alternatives table", async () => {
    vi.mocked(api.runOptimization).mockResolvedValue({
      data: COMPROMISE_OPTIONS,
      source: "api",
    });

    await simulate();

    const alternatives = await screen.findByRole("heading", { name: "Other ways to do this" });
    const apply = screen.getByRole("button", { name: "Apply Compromise" });
    expect(
      alternatives.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the backend's error instead of fixture numbers", async () => {
    vi.mocked(api.runSimulation).mockRejectedValue(new Error("horizon too long"));
    await simulate();
    // SM-3 and G-14: the message lands in the form, and no numbers appear.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("horizon too long"));
    expect(screen.queryByText("No Purchase")).not.toBeInTheDocument();
  });

  it("does not optimize against the saved offline example", async () => {
    vi.mocked(api.runSimulation).mockResolvedValue({ data: SIMULATION, source: "fixture" });
    await simulate();
    await waitFor(() => expect(screen.getByText("No Purchase")).toBeInTheDocument());
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
    expect(screen.getByLabelText("Amount")).toHaveValue(450);
    expect(screen.getByLabelText("Date")).toHaveValue("2026-10-01");
    // AS-8: the Assistant hands the purchase over; the user still presses Simulate.
    expect(api.runSimulation).not.toHaveBeenCalled();
  });

  it("keeps its defaults when the link carries nothing usable", async () => {
    query = "amount=free";
    renderSimulate();

    await waitFor(() => expect(screen.getByLabelText("What")).toHaveValue("Laptop"));
    expect(screen.getByLabelText("Amount")).toHaveValue(800);
    expect(api.runSimulation).not.toHaveBeenCalled();
  });
});
