import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import mockSimulation from "@/lib/mock/simulation.json";
import type { SimulationResponse } from "@/lib/types";
import { ExplanationPanel } from "./ExplanationPanel";

const SIMULATION = mockSimulation as unknown as SimulationResponse;

const render_ = (overrides: Partial<SimulationResponse> = {}) =>
  render(<ExplanationPanel simulation={{ ...SIMULATION, ...overrides }} />);

describe("ExplanationPanel", () => {
  it("shows the backend's own summary, not a generated one", () => {
    render_({ summary: "Buying the laptop leaves $800 less by May." });
    expect(screen.getByText("Buying the laptop leaves $800 less by May.")).toBeInTheDocument();
  });

  it("signs each driver by the direction the contract gave it", () => {
    render_({
      drivers: [
        { label: "Laptop", impact_amount: -800, direction: "negative", detail: "One-off." },
        { label: "Paychecks", impact_amount: 2880, direction: "positive", detail: "Biweekly." },
      ],
    });
    expect(screen.getByText("-$800")).toBeInTheDocument();
    expect(screen.getByText("+$2,880")).toBeInTheDocument();
  });

  it("trusts the stated direction over the sign of the amount", () => {
    const { container } = render(
      <ExplanationPanel
        simulation={{
          ...SIMULATION,
          drivers: [
            { label: "Refund", impact_amount: 200, direction: "negative", detail: "d" },
          ],
        }}
      />,
    );
    expect(container.querySelector(".text-bad")).toHaveTextContent("+$200");
  });

  it("keeps a declared commitment distinguishable from a hypothetical purchase", () => {
    // Both are negative, so both render in the same colour. The distinction has to
    // survive in the words (frontend/SPEC.md 13:768), and the panel must pass the
    // backend's wording through rather than summarising it away.
    const { container } = render_({
      drivers: [
        {
          label: "Laptop (this purchase)",
          impact_amount: -800,
          direction: "negative",
          detail: "The purchase being simulated. It happens in one scenario only.",
        },
        {
          label: "Tuition (already owed)",
          impact_amount: -1200,
          direction: "negative",
          detail: "A commitment Alex declared. It is spent in both scenarios.",
        },
      ],
    });
    expect(screen.getByText("Laptop (this purchase)")).toBeInTheDocument();
    expect(screen.getByText("Tuition (already owed)")).toBeInTheDocument();
    expect(
      screen.getByText("The purchase being simulated. It happens in one scenario only."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("A commitment Alex declared. It is spent in both scenarios."),
    ).toBeInTheDocument();
    // Colour alone would not tell them apart: both are styled the same.
    expect(container.querySelectorAll(".text-bad")).toHaveLength(2);
  });

  it("renders every assumption the simulation declared", () => {
    render_({ assumptions: ["Spending follows observed averages.", "No new income."] });
    expect(screen.getByText("Spending follows observed averages.")).toBeInTheDocument();
    expect(screen.getByText("No new income.")).toBeInTheDocument();
  });

  // The assumption string is used as the React key, so a repeated one would
  // collide and drop a row.
  it("renders repeated assumptions without losing one", () => {
    render_({ assumptions: ["Same wording.", "Same wording."] });
    expect(screen.getAllByText("Same wording.")).toHaveLength(2);
  });

  it("handles a result with no drivers at all", () => {
    render_({ drivers: [] });
    expect(screen.getByText("Biggest drivers")).toBeInTheDocument();
  });

  it("cites the simulation it is explaining and leaves the decision to Alex", () => {
    render_({ simulation_id: "sim-42" });
    expect(screen.getByText(/Simulation sim-42/)).toBeInTheDocument();
    expect(screen.getByText(/the decision is yours/)).toBeInTheDocument();
  });
});
