import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/dates";
import type { BalanceBandPoint, BalanceBands } from "@/lib/types";
import { PREVIEW_DAYS, TrajectoryPreview, cutBands } from "./TrajectoryPreview";

const AS_OF = "2026-09-18";
const HORIZON_END = "2027-05-01";
const DAYS = 225;

/** A series whose values are distinct per day, so a slice is visible in them. */
function series(offset: number): BalanceBandPoint[] {
  return Array.from({ length: DAYS }, (_, i) => ({
    date: addDays(AS_OF, i),
    p10: 1000 + i + offset,
    median: 2000 + i + offset,
    p90: 3000 + i + offset,
  }));
}

const BANDS: BalanceBands = {
  baseline: { total: series(0), checking: series(5) },
  counterfactual: { total: series(-800), checking: series(-795) },
};

function renderPreview(bands: BalanceBands | null = BANDS) {
  render(
    <TrajectoryPreview bands={bands} asOf={AS_OF} horizonEnd={HORIZON_END} simulations={1000} />,
  );
  return userEvent.setup();
}

describe("TrajectoryPreview", () => {
  // SM-8
  it("is closed until the reader opens it", () => {
    renderPreview();
    const summary = screen.getByText(`Balance over the next ${PREVIEW_DAYS} days`);
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });

  it("opens on the 90-day window and says the figures above cover more", () => {
    renderPreview();
    expect(screen.getByRole("button", { name: "90 days" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByText("Chart shows 90 days. Figures above cover through May 1, 2027."),
    ).toBeInTheDocument();
  });

  it("plots to the ninetieth day, not to the horizon", () => {
    renderPreview();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
      "to December 17, 2026",
    );
  });

  it("drops the caption and plots the whole horizon on the other setting", async () => {
    const user = renderPreview();
    await user.click(screen.getByRole("button", { name: "Full horizon" }));
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("to April 30, 2027");
    expect(screen.queryByText(/Chart shows/)).not.toBeInTheDocument();
  });

  // SM-10 / E-5
  it("says there is no projection rather than drawing an empty chart", () => {
    renderPreview(null);
    expect(screen.getByText("No projection available for this result.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("cutBands", () => {
  // SM-9: the window is a slice. Nothing is resampled, skewed or smoothed.
  it("keeps the backend's own values, up to and including the last day", () => {
    const last = addDays(AS_OF, PREVIEW_DAYS);
    const cut = cutBands(BANDS, last);
    const kept = cut.baseline.total;

    expect(kept).toHaveLength(PREVIEW_DAYS + 1);
    expect(kept[kept.length - 1].date).toBe(last);
    expect(kept).toEqual(BANDS.baseline.total.slice(0, PREVIEW_DAYS + 1));
    expect(cut.counterfactual.checking[0]).toBe(BANDS.counterfactual.checking[0]);
  });
});
