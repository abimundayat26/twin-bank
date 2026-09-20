import { fireEvent, render, screen, within } from "@testing-library/react";
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

/** The hover readout, which only exists while a day is hovered. */
const READOUT = "div.pointer-events-none.absolute";

/**
 * Queries scoped to the hover readout.
 *
 * The G-19 table repeats every figure the readout shows, so an unscoped query
 * for a dollar amount now matches twice.
 */
const readout = (container: HTMLElement) =>
  within(container.querySelector(READOUT) as HTMLElement);

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
    expect(label).toContain("a difference of −$800");
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

  it("shows the simulator-default low-balance line only on checking", async () => {
    const user = userEvent.setup();
    render(
      <BalanceTrajectoryChart
        bands={bands(30)}
        checkingMinimum={200}
        checkingMinimumIsDefault
      />,
    );
    expect(screen.queryByText("Default low-balance $200")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Checking" }));
    expect(screen.getByText("Default low-balance $200")).toBeInTheDocument();
    expect(plot()).toHaveAccessibleName(/Default low-balance \$200 reference line is shown/);
  });

  it("identifies Alex's declared checking minimum instead of calling it a default", async () => {
    const user = userEvent.setup();
    render(<BalanceTrajectoryChart bands={bands(30)} checkingMinimum={350} />);
    await user.click(screen.getByRole("button", { name: "Checking" }));

    expect(screen.getByText("Minimum $350")).toBeInTheDocument();
    expect(screen.queryByText(/Default low-balance/)).not.toBeInTheDocument();
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
    // The legend, and the two column headers of the G-19 table.
    expect(screen.getAllByText(/Delayed to October/).length).toBeGreaterThan(0);
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
    expect(readout(container).getByText("September 19, 2026")).toBeInTheDocument();
    expect(readout(container).getByText("$3,000.00")).toBeInTheDocument();
    expect(readout(container).getByText("$2,200.00")).toBeInTheDocument();
    // G-2's true minus, and scoped to the readout because the G-19 table now
    // repeats every figure the tooltip shows.
    expect(readout(container).getByText("−$800")).toBeInTheDocument();

    fireEvent.pointerMove(target, { clientX: 300, clientY: 10 });
    expect(readout(container).getByText("October 18, 2026")).toBeInTheDocument();

    fireEvent.pointerLeave(target);
    expect(container.querySelector(READOUT)).toBeNull();
  });

  it("shows the counterfactual's own 10th-to-90th range at the hovered day", () => {
    const { container } = render(<BalanceTrajectoryChart bands={bands(30)} />);
    const target = container.querySelector('rect[fill="transparent"]') as SVGRectElement;
    target.getBoundingClientRect = () =>
      ({ left: 0, width: 300, top: 0, height: 200 }) as DOMRect;

    fireEvent.pointerMove(target, { clientX: 0, clientY: 10 });
    expect(readout(container).getByText("$2,100 to $2,300")).toBeInTheDocument();
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

  /** Every y-axis label, in the order they are drawn. */
  const axisLabels = (container: HTMLElement) =>
    [...container.querySelectorAll("text[text-anchor='end']")]
      .map((node) => node.textContent ?? "")
      .filter((text) => text.startsWith("$") || text.startsWith("-$"));

  describe("the y axis (TR-3)", () => {
    it("labels 4 to 7 ticks in whole dollars, with no cents", () => {
      const { container } = render(<BalanceTrajectoryChart bands={bands(120)} />);
      const labels = axisLabels(container);
      expect(labels.length).toBeGreaterThanOrEqual(4);
      expect(labels.length).toBeLessThanOrEqual(7);
      for (const label of labels) expect(label).not.toContain(".");
    });

    it("steps by a round amount rather than by the data's own extremes", () => {
      const { container } = render(<BalanceTrajectoryChart bands={bands(120)} />);
      // Labels run top to bottom, so the gaps are negative; the size is what matters.
      const values = axisLabels(container).map((label) => Number(label.replace(/[$,]/g, "")));
      const steps = values.slice(1).map((value, index) => Math.abs(value - values[index]));
      expect(new Set(steps).size).toBe(1);
      const mantissa = steps[0] / 10 ** Math.floor(Math.log10(steps[0]));
      expect([1, 2, 2.5, 5]).toContain(mantissa);
    });
  });

  describe("the x axis (TR-4)", () => {
    // G-1: the twin's own year is implied, any other year is spelled out.
    it("omits the year inside the twin's year and shows it outside", () => {
      const { container } = render(
        <BalanceTrajectoryChart bands={bands(200)} asOf="2026-09-19" />,
      );
      const labels = [...container.querySelectorAll("text[text-anchor='middle']")].map(
        (node) => node.textContent ?? "",
      );
      expect(labels).toContain("Oct 1");
      expect(labels).toContain("Jan 1, 2027");
    });

    it("falls back to the first plotted day when no as-of is given", () => {
      const { container } = render(<BalanceTrajectoryChart bands={bands(60)} />);
      const labels = [...container.querySelectorAll("text[text-anchor='middle']")].map(
        (node) => node.textContent ?? "",
      );
      expect(labels).toContain("Oct 1");
    });
  });

  describe("the text equivalent (TR-6, G-19)", () => {
    it("tabulates the plotted values for a screen reader", () => {
      render(<BalanceTrajectoryChart bands={bands(60)} />);
      const table = screen.getByRole("table");
      expect(table).toHaveClass("sr-only");
      // Both ends of the horizon, plus each month the axis labels.
      expect(within(table).getByRole("rowheader", { name: "September 19, 2026" })).toBeInTheDocument();
      expect(within(table).getByRole("rowheader", { name: "November 17, 2026" })).toBeInTheDocument();
      expect(within(table).getAllByRole("row").length).toBeGreaterThanOrEqual(4);
    });

    it("reads the same numbers the lines are drawn from", () => {
      render(<BalanceTrajectoryChart bands={bands(60)} />);
      const row = screen.getByRole("row", { name: /September 19, 2026/ });
      // series() starts the baseline at $3,000 with the counterfactual $800 below.
      expect(within(row).getByText("$3,000")).toBeInTheDocument();
      expect(within(row).getByText("$2,200")).toBeInTheDocument();
      expect(within(row).getByText("$2,900 to $3,100")).toBeInTheDocument();
    });

    it("drops the narrative footer", () => {
      render(<BalanceTrajectoryChart bands={bands(60)} simulations={2000} />);
      expect(screen.queryByText(/measured mid-day/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Lines are the median across/)).not.toBeInTheDocument();
    });
  });

  // TR-7: the card scrolls, not the page (G-20).
  it("keeps a narrow screen's overflow inside the card", () => {
    const { container } = render(<BalanceTrajectoryChart bands={bands(60)} />);
    const scroller = container.querySelector("div.overflow-x-auto");
    expect(scroller).not.toBeNull();
    expect(scroller?.querySelector("svg")).not.toBeNull();
  });
});
