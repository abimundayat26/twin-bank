import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import mockSimulation from "@/lib/mock/simulation.json";
import type { BalanceBandPoint, BalanceBands, SimulationResponse } from "@/lib/types";
import { BalanceTrajectoryChart } from "./BalanceTrajectoryChart";

const SIMULATION = mockSimulation as unknown as SimulationResponse;

/** `days` consecutive points from 2026-09-19, each `step` dollars apart. */
function series(start: number, days: number, step = 0): BalanceBandPoint[] {
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.UTC(2026, 8, 19 + i)).toISOString().slice(0, 10);
    const median = start + i * step;
    return { date, p10: median - 100, median, p90: median + 100 };
  });
}

function bands(
  baselineDays: number,
  counterfactualDays = baselineDays,
  offset = -800,
): BalanceBands {
  return {
    baseline: { total: series(3000, baselineDays, 5), checking: series(1200, baselineDays, 2) },
    counterfactual: {
      total: series(3000 + offset, counterfactualDays, 5),
      checking: series(1200 + offset, counterfactualDays, 2),
    },
  };
}

const plot = () => screen.getByRole("img");

describe("BalanceTrajectoryChart", () => {
  it("degrades to a sentence rather than crashing when a result has no bands", () => {
    render(<BalanceTrajectoryChart bands={null} />);
    expect(screen.getByText(/No balance trajectory in this result/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("says the same when the bands key is missing altogether", () => {
    render(<BalanceTrajectoryChart />);
    expect(screen.getByText(/No balance trajectory in this result/)).toBeInTheDocument();
  });

  // One point is a dot, not a trajectory, and makeScaleX has no span to work with.
  it("refuses to draw a trajectory from a single day", () => {
    render(<BalanceTrajectoryChart bands={bands(1)} />);
    expect(screen.getByText(/No balance trajectory in this result/)).toBeInTheDocument();
  });

  it("draws a trajectory from two days", () => {
    render(<BalanceTrajectoryChart bands={bands(2)} />);
    expect(plot()).toBeInTheDocument();
  });

  // A hand-edited or truncated fixture would otherwise index past the shorter
  // array and poison a path with undefined.
  it("plots only the days both scenarios cover", () => {
    render(<BalanceTrajectoryChart bands={bands(40, 10)} />);
    const label = plot().getAttribute("aria-label")!;
    // The 10th day of the series, not the 40th.
    expect(label).toContain("September 28, 2026");
  });

  it("describes both endpoints and the difference for a screen reader", () => {
    render(<BalanceTrajectoryChart bands={bands(30)} simulations={1000} />);
    const label = plot().getAttribute("aria-label")!;
    expect(label).toContain("1,000 simulated futures");
    expect(label).toContain("a difference of -$800");
  });

  it("says 'the simulation' rather than inventing a run count", () => {
    render(<BalanceTrajectoryChart bands={bands(30)} simulations={null} />);
    expect(plot().getAttribute("aria-label")).toContain("across the simulation");
  });

  it("switches between the total and checking balances", async () => {
    const user = userEvent.setup();
    render(<BalanceTrajectoryChart bands={bands(30)} />);
    expect(plot().getAttribute("aria-label")).toContain("Projected total balance");

    await user.click(screen.getByRole("button", { name: "Checking" }));
    expect(plot().getAttribute("aria-label")).toContain("Projected checking balance");
    expect(screen.getByRole("button", { name: "Checking" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("says plainly when a purchase moves no median at all", () => {
    render(<BalanceTrajectoryChart bands={bands(30, 30, 0)} />);
    expect(screen.getByText(/does not change the projected median/)).toBeInTheDocument();
  });

  it("does not claim the paths coincide when they do not", () => {
    render(<BalanceTrajectoryChart bands={bands(30)} />);
    expect(screen.queryByText(/the two paths coincide/)).not.toBeInTheDocument();
  });

  it("draws the reserve line only where it means something", () => {
    const { container, rerender } = render(
      <BalanceTrajectoryChart bands={bands(30)} reserve={1500} />,
    );
    expect(screen.getByText("Reserve $1,500")).toBeInTheDocument();

    // The reserve is checking plus savings, so it is not a line on checking alone.
    rerender(<BalanceTrajectoryChart bands={bands(30)} reserve={0} />);
    expect(screen.queryByText(/Reserve/)).not.toBeInTheDocument();
    expect(container).toBeTruthy();
  });

  it("drops the reserve line when only checking is plotted", async () => {
    const user = userEvent.setup();
    render(<BalanceTrajectoryChart bands={bands(30)} reserve={1500} />);
    await user.click(screen.getByRole("button", { name: "Checking" }));
    expect(screen.queryByText("Reserve $1,500")).not.toBeInTheDocument();
  });

  it("marks the dates it was given", () => {
    render(
      <BalanceTrajectoryChart
        bands={bands(30)}
        markers={[{ date: "2026-09-25", label: "Laptop", tone: "counter" }]}
      />,
    );
    expect(screen.getByText("Laptop")).toBeInTheDocument();
  });

  it("silently drops a marker outside the horizon instead of pinning it to an edge", () => {
    render(
      <BalanceTrajectoryChart
        bands={bands(30)}
        markers={[
          { date: "2027-05-01", label: "Goal deadline", tone: "faint" },
          { date: "2020-01-01", label: "Long ago", tone: "faint" },
        ]}
      />,
    );
    expect(screen.queryByText("Goal deadline")).not.toBeInTheDocument();
    expect(screen.queryByText("Long ago")).not.toBeInTheDocument();
  });

  it("lets the caller rename the counterfactual line", () => {
    render(
      <BalanceTrajectoryChart bands={bands(30)} counterfactualLabel="Delayed to October" />,
    );
    expect(screen.getByText(/Delayed to October/)).toBeInTheDocument();
  });

  it("plots the bundled simulation fixture end to end", () => {
    render(
      <BalanceTrajectoryChart
        bands={SIMULATION.balance_bands}
        simulations={SIMULATION.num_simulations}
        reserve={1500}
      />,
    );
    expect(plot()).toBeInTheDocument();
    expect(screen.getByText("Reserve $1,500")).toBeInTheDocument();
  });

  // The whole plot is one hit target, so the day has to be derived from where in
  // its box the pointer landed. jsdom lays nothing out, so the box is stubbed.
  it("names the day and both balances on hover", () => {
    const { container } = render(<BalanceTrajectoryChart bands={bands(30)} />);
    const target = container.querySelector('rect[fill="transparent"]') as SVGRectElement;
    target.getBoundingClientRect = () =>
      ({ left: 0, width: 300, top: 0, height: 200 }) as DOMRect;

    fireEvent.pointerMove(target, { clientX: 0, clientY: 10 });
    expect(screen.getByText("September 19, 2026")).toBeInTheDocument();
    expect(screen.getByText("$3,000.00")).toBeInTheDocument();
    expect(screen.getByText("$2,200.00")).toBeInTheDocument();
    expect(screen.getByText("-$800")).toBeInTheDocument();

    fireEvent.pointerMove(target, { clientX: 300, clientY: 10 });
    expect(screen.getByText("October 18, 2026")).toBeInTheDocument();

    fireEvent.pointerLeave(target);
    expect(screen.queryByText("October 18, 2026")).not.toBeInTheDocument();
  });

  it("shows the counterfactual's own 10th-to-90th range at the hovered day", () => {
    const { container } = render(<BalanceTrajectoryChart bands={bands(30)} />);
    const target = container.querySelector('rect[fill="transparent"]') as SVGRectElement;
    target.getBoundingClientRect = () =>
      ({ left: 0, width: 300, top: 0, height: 200 }) as DOMRect;

    fireEvent.pointerMove(target, { clientX: 0, clientY: 10 });
    expect(screen.getByText("$2,100 to $2,300")).toBeInTheDocument();
  });

  // A pointer event before layout gives a zero-width box; dividing by it would
  // put the tooltip on day NaN.
  it("ignores a pointer move over a box with no width", () => {
    const { container } = render(<BalanceTrajectoryChart bands={bands(30)} />);
    const target = container.querySelector('rect[fill="transparent"]') as SVGRectElement;
    fireEvent.pointerMove(target, { clientX: 40, clientY: 10 });
    // The tooltip's own exact-dollar reading; the chart's caption is unaffected.
    expect(screen.queryByText("$3,000.00")).not.toBeInTheDocument();
  });
});
