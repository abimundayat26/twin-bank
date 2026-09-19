import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SeasonalProfile } from "@/lib/types";
import { SeasonalSparkline } from "./SeasonalSparkline";

const PROFILE: SeasonalProfile = {
  factors: {
    "1": 0.8, "2": 0.8, "3": 0.9, "4": 0.9, "5": 1.0, "6": 1.1,
    "7": 1.1, "8": 1.2, "9": 1.0, "10": 1.0, "11": 1.1, "12": 1.1,
  },
};

const bars = (container: HTMLElement) =>
  [...container.querySelectorAll("rect")].filter((r) => r.getAttribute("fill") !== "transparent");

describe("SeasonalSparkline", () => {
  it("is an image with the summary as its accessible name", () => {
    render(<SeasonalSparkline profile={PROFILE} currentMonth={9} label="Groceries by month" />);
    expect(screen.getByRole("img", { name: "Groceries by month" })).toBeInTheDocument();
  });

  it("draws one bar per calendar month", () => {
    const { container } = render(
      <SeasonalSparkline profile={PROFILE} currentMonth={9} label="l" />,
    );
    expect(bars(container)).toHaveLength(12);
  });

  it("picks out the month the twin describes", () => {
    const { container } = render(
      <SeasonalSparkline profile={PROFILE} currentMonth={9} label="l" />,
    );
    const inked = bars(container).filter((r) => r.classList.contains("fill-ink"));
    expect(inked).toHaveLength(1);
    expect(bars(container).indexOf(inked[0])).toBe(8);
  });

  it("inks no bar when the month is outside 1-12", () => {
    const { container } = render(
      <SeasonalSparkline profile={PROFILE} currentMonth={0} label="l" />,
    );
    expect(bars(container).filter((r) => r.classList.contains("fill-ink"))).toHaveLength(0);
  });

  it("labels each bar with its month and factor on hover", () => {
    render(<SeasonalSparkline profile={PROFILE} currentMonth={9} label="l" />);
    expect(screen.getByText("August: 1.20× an average fortnight")).toBeInTheDocument();
    expect(screen.getByText("January: 0.80× an average fortnight")).toBeInTheDocument();
  });

  // A month the profile leaves out is an average month, not a missing bar.
  it("treats a month the profile omits as average", () => {
    const { container } = render(
      <SeasonalSparkline profile={{ factors: { "1": 2 } }} currentMonth={1} label="l" />,
    );
    expect(bars(container)).toHaveLength(12);
    expect(screen.getByText("June: 1.00× an average fortnight")).toBeInTheDocument();
  });

  it("handles an entirely empty profile without dropping the chart", () => {
    const { container } = render(
      <SeasonalSparkline profile={{ factors: {} }} currentMonth={3} label="l" />,
    );
    expect(bars(container)).toHaveLength(12);
  });

  // A zero-factor month is a real answer: draw it flat, not off the chart.
  it("keeps a zero-factor month inside the chart", () => {
    const { container } = render(
      <SeasonalSparkline profile={{ factors: { "1": 0, "2": 2 } }} currentMonth={1} label="l" />,
    );
    for (const bar of bars(container)) {
      const y = Number(bar.getAttribute("y"));
      const height = Number(bar.getAttribute("height"));
      expect(Number.isFinite(y)).toBe(true);
      expect(height).toBeGreaterThanOrEqual(0);
      expect(y + height).toBeLessThanOrEqual(20);
    }
  });
});
