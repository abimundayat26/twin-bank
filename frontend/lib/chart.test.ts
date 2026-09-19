import { describe, expect, it } from "vitest";

import {
  alignedLength,
  areIdentical,
  buildBandPath,
  buildPath,
  extremeIndices,
  keepIndices,
  makeScaleX,
  makeScaleY,
  MAX_PLOT_POINTS,
  MIN_Y_PAD,
  monthTickPositions,
  positionOfDate,
  toTrack,
  yDomain,
} from "./chart";
import mockSimulation from "./mock/simulation.json";
import type { BalanceBandPoint, SimulationResponse } from "./types";

/** A day of band data. Percentiles default to a sane p10 <= median <= p90. */
function point(date: string, median: number, spread = 100): BalanceBandPoint {
  return { date, p10: median - spread, median, p90: median + spread };
}

function days(count: number, from = "2026-09-19"): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}

describe("alignedLength", () => {
  it("is zero when either scenario is missing", () => {
    expect(alignedLength(undefined, undefined)).toBe(0);
    expect(alignedLength(null, [point("2026-09-19", 100)])).toBe(0);
    expect(alignedLength([point("2026-09-19", 100)], null)).toBe(0);
  });

  it("is the shared length when both scenarios match", () => {
    const a = days(3).map((d) => point(d, 100));
    expect(alignedLength(a, a)).toBe(3);
  });

  it("takes the shorter of the two, so a truncated fixture cannot read past the end", () => {
    const long = days(5).map((d) => point(d, 100));
    expect(alignedLength(long, long.slice(0, 2))).toBe(2);
    expect(alignedLength(long.slice(0, 2), long)).toBe(2);
  });

  it("is zero for an empty scenario", () => {
    expect(alignedLength([], [point("2026-09-19", 100)])).toBe(0);
  });
});

describe("toTrack", () => {
  const points = [point("2026-09-19", 100, 10), point("2026-09-20", 200, 20)];

  it("splits band points into parallel arrays", () => {
    expect(toTrack(points, 2)).toEqual({
      dates: ["2026-09-19", "2026-09-20"],
      p10: [90, 180],
      median: [100, 200],
      p90: [110, 220],
    });
  });

  it("truncates to the aligned count", () => {
    expect(toTrack(points, 1).median).toEqual([100]);
  });

  it("returns nothing for a count of zero or less", () => {
    expect(toTrack(points, 0).median).toEqual([]);
    expect(toTrack(points, -3).median).toEqual([]);
  });

  it("never returns more days than it was given", () => {
    expect(toTrack(points, 99).dates).toHaveLength(2);
  });

  it("turns a missing percentile into NaN rather than undefined", () => {
    // Cast: a hand-edited fixture is exactly the case this guards.
    const damaged = [{ date: "2026-09-19", median: 100 } as BalanceBandPoint];
    const track = toTrack(damaged, 1);
    expect(Number.isNaN(track.p10[0])).toBe(true);
    expect(Number.isNaN(track.p90[0])).toBe(true);
    expect(track.median[0]).toBe(100);
  });
});

describe("extremeIndices", () => {
  it("finds the lowest and highest values", () => {
    expect(extremeIndices([5, 1, 9, 3])).toEqual([1, 2]);
  });

  it("ignores non-finite values instead of picking them as extremes", () => {
    expect(extremeIndices([NaN, 4, Infinity, 2])).toEqual([3, 1]);
  });

  it("returns nothing when there is nothing finite to pick", () => {
    expect(extremeIndices([])).toEqual([]);
    expect(extremeIndices([NaN, NaN])).toEqual([]);
  });

  it("reports the same index twice for a flat series", () => {
    expect(extremeIndices([7, 7, 7])).toEqual([0, 0]);
  });
});

describe("keepIndices", () => {
  it("keeps everything when the series is short enough", () => {
    expect(keepIndices(4)).toEqual([0, 1, 2, 3]);
  });

  it("keeps nothing for an empty series", () => {
    expect(keepIndices(0)).toEqual([]);
  });

  it("decimates a long series below the cap", () => {
    const kept = keepIndices(1000);
    expect(kept.length).toBeLessThanOrEqual(MAX_PLOT_POINTS + 2);
    expect(kept.length).toBeLessThan(1000);
  });

  it("always keeps the first and last day", () => {
    const kept = keepIndices(1000);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(999);
  });

  it("keeps a one-day trough that plain striding would drop", () => {
    // 501 is not a multiple of the stride for a 1000-point series.
    expect(keepIndices(1000, [501])).toContain(501);
  });

  it("ignores an extreme outside the series", () => {
    const kept = keepIndices(10, [-1, 99], 5);
    expect(kept).not.toContain(-1);
    expect(kept).not.toContain(99);
  });

  it("returns ascending, unique indices", () => {
    const kept = keepIndices(1000, [0, 999, 500, 500]);
    expect([...kept].sort((a, b) => a - b)).toEqual(kept);
    expect(new Set(kept).size).toBe(kept.length);
  });
});

describe("yDomain", () => {
  it("pads the range so lines do not touch the frame", () => {
    const { lo, hi } = yDomain([[0, 100]]);
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(100);
  });

  it("falls back to a sane axis with no values at all", () => {
    expect(yDomain([])).toEqual({ lo: -MIN_Y_PAD, hi: MIN_Y_PAD });
    expect(yDomain([[NaN, Infinity]])).toEqual({ lo: -MIN_Y_PAD, hi: MIN_Y_PAD });
  });

  it("keeps the reserve on screen even when no line goes near it", () => {
    // The demo case: the reserve sits below the whole projection.
    const { lo } = yDomain([[3000, 3500]], [500]);
    expect(lo).toBeLessThanOrEqual(500);
  });

  it("gives a flat series real height instead of a zero-span axis", () => {
    const { lo, hi } = yDomain([[200, 200]]);
    expect(hi - lo).toBeGreaterThanOrEqual(2 * MIN_Y_PAD);
  });

  it("puts zero on the chart when a balance goes underwater", () => {
    // An overdrawn projection only reads as overdrawn if the zero line is visible.
    const { hi } = yDomain([[-500, -100]]);
    expect(hi).toBeGreaterThanOrEqual(0);
  });

  it("spans every scenario it is given, not just the first", () => {
    const { lo, hi } = yDomain([
      [100, 200],
      [-50, 900],
    ]);
    expect(lo).toBeLessThan(-50);
    expect(hi).toBeGreaterThan(900);
  });
});

describe("makeScaleX", () => {
  it("puts the first point at the left edge and the last at the right", () => {
    const scale = makeScaleX(5, 50, 600);
    expect(scale(0)).toBe(50);
    expect(scale(4)).toBe(650);
  });

  it("spaces points evenly, since the engine emits one per day", () => {
    const scale = makeScaleX(5, 0, 400);
    expect(scale(1) - scale(0)).toBeCloseTo(scale(3) - scale(2));
  });

  it("centres a single point rather than dividing by zero", () => {
    expect(makeScaleX(1, 0, 400)(0)).toBe(200);
  });
});

describe("makeScaleY", () => {
  it("inverts the axis, because SVG y grows downward", () => {
    const scale = makeScaleY({ lo: 0, hi: 100 }, 10, 200);
    expect(scale(100)).toBe(10);
    expect(scale(0)).toBe(210);
    expect(scale(100)).toBeLessThan(scale(0));
  });

  it("centres everything when the domain has no span", () => {
    expect(makeScaleY({ lo: 5, hi: 5 }, 0, 100)(5)).toBe(50);
  });
});

describe("buildPath", () => {
  const scaleX = (index: number) => index * 10;
  const scaleY = (value: number) => value;

  it("moves to the first point and lines to the rest", () => {
    expect(buildPath([1, 2], scaleX, scaleY)).toBe("M0.0 1.0L10.0 2.0");
  });

  it("is empty for an empty series", () => {
    expect(buildPath([], scaleX, scaleY)).toBe("");
  });

  it("skips a bad point instead of blanking the whole line", () => {
    // One NaN inside an `L` command erases the entire path in SVG.
    const path = buildPath([1, NaN, 3], scaleX, scaleY);
    expect(path).not.toContain("NaN");
    expect(path).toBe("M0.0 1.0L20.0 3.0");
  });

  it("starts at the first finite point when the series opens with a bad one", () => {
    expect(buildPath([NaN, 2], scaleX, scaleY)).toBe("M10.0 2.0");
  });

  it("is empty when nothing is finite", () => {
    expect(buildPath([NaN, Infinity], scaleX, scaleY)).toBe("");
  });
});

describe("buildBandPath", () => {
  const scaleX = (index: number) => index * 10;
  const scaleY = (value: number) => value;

  it("closes the fan so it can be filled", () => {
    expect(buildBandPath([3, 4], [1, 2], scaleX, scaleY)).toMatch(/Z$/);
  });

  it("walks the lower edge backwards, so the shape does not self-cross", () => {
    const path = buildBandPath([3, 4], [1, 2], scaleX, scaleY);
    expect(path).toBe("M0.0 3.0L10.0 4.0L10.0 2.0L0.0 1.0Z");
  });

  it("is empty when the upper edge has nothing to draw", () => {
    expect(buildBandPath([], [1, 2], scaleX, scaleY)).toBe("");
    expect(buildBandPath([NaN], [1], scaleX, scaleY)).toBe("");
  });

  it("is empty when the lower edge has nothing to draw", () => {
    expect(buildBandPath([1, 2], [NaN, NaN], scaleX, scaleY)).toBe("");
  });
});

describe("monthTickPositions", () => {
  it("marks each month boundary", () => {
    const dates = ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
    expect(monthTickPositions(dates, [0, 1, 2, 3])).toEqual([2]);
  });

  it("marks nothing inside a single month", () => {
    expect(monthTickPositions(["2026-09-01", "2026-09-02"], [0, 1])).toEqual([]);
  });

  it("returns kept-index positions, not raw day indices", () => {
    // Decimated: only every other day survives. The tick must point at the
    // position in the plotted array, or the label lands on the wrong day.
    const dates = ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
    expect(monthTickPositions(dates, [0, 2])).toEqual([1]);
  });

  it("thins a long horizon down to the tick budget", () => {
    const dates = Array.from({ length: 24 }, (_, i) => `20${26 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`);
    const kept = dates.map((_, i) => i);
    expect(monthTickPositions(dates, kept, 4).length).toBeLessThanOrEqual(4);
  });

  it("survives a hole in the date array", () => {
    expect(() => monthTickPositions([], [0, 1], 4)).not.toThrow();
    expect(monthTickPositions([], [0, 1], 4)).toEqual([]);
  });
});

describe("areIdentical", () => {
  it("is true when a purchase changes nothing", () => {
    expect(areIdentical([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it("is false when any single day differs", () => {
    expect(areIdentical([1, 2, 3], [1, 2, 4])).toBe(false);
  });

  it("is false for different lengths", () => {
    expect(areIdentical([1, 2], [1, 2, 3])).toBe(false);
  });

  it("is true for two empty series", () => {
    expect(areIdentical([], [])).toBe(true);
  });
});

describe("positionOfDate", () => {
  const dates = days(5); // 2026-09-19 .. 2026-09-23

  it("finds an exact day", () => {
    expect(positionOfDate(dates, [0, 1, 2, 3, 4], "2026-09-21")).toBe(2);
  });

  it("refuses a date before the horizon", () => {
    expect(positionOfDate(dates, [0, 1, 2, 3, 4], "2026-09-01")).toBe(-1);
  });

  it("refuses a date after the horizon", () => {
    expect(positionOfDate(dates, [0, 1, 2, 3, 4], "2027-01-01")).toBe(-1);
  });

  it("snaps to the nearest kept day when the exact one was decimated away", () => {
    // Only days 0, 2 and 4 survived; the 20th is nearest the 19th and the 21st.
    const kept = [0, 2, 4];
    expect([0, 1]).toContain(positionOfDate(dates, kept, "2026-09-20"));
  });

  it("returns a kept position, not a raw day index", () => {
    expect(positionOfDate(dates, [0, 2, 4], "2026-09-23")).toBe(2);
  });

  it("refuses everything when nothing was kept", () => {
    expect(positionOfDate(dates, [], "2026-09-21")).toBe(-1);
  });
});

describe("the bundled fixture, which is what the demo shows when the backend is down", () => {
  const bands = (mockSimulation as SimulationResponse).balance_bands;

  it("carries bands the chart can actually plot", () => {
    expect(bands).toBeTruthy();
    expect(alignedLength(bands?.baseline.total, bands?.counterfactual.total)).toBeGreaterThan(1);
    expect(alignedLength(bands?.baseline.checking, bands?.counterfactual.checking)).toBeGreaterThan(1);
  });

  it("keeps both scenarios on the same days", () => {
    const base = toTrack(bands!.baseline.total, alignedLength(bands!.baseline.total, bands!.counterfactual.total));
    const counter = toTrack(bands!.counterfactual.total, base.dates.length);
    expect(counter.dates).toEqual(base.dates);
  });

  it("orders every day p10 <= median <= p90", () => {
    // A crossed band would render as a self-intersecting shape.
    for (const scenario of [bands!.baseline, bands!.counterfactual]) {
      for (const metric of [scenario.total, scenario.checking]) {
        for (const day of metric) {
          expect(day.p10).toBeLessThanOrEqual(day.median);
          expect(day.median).toBeLessThanOrEqual(day.p90);
        }
      }
    }
  });

  it("produces a finite path with no NaN in it", () => {
    const count = alignedLength(bands!.baseline.total, bands!.counterfactual.total);
    const track = toTrack(bands!.counterfactual.total, count);
    const kept = keepIndices(count, extremeIndices(track.median));
    const domain = yDomain([kept.map((i) => track.p10[i]), kept.map((i) => track.p90[i])]);
    const path = buildPath(kept.map((i) => track.median[i]), makeScaleX(kept.length, 56, 648), makeScaleY(domain, 14, 220));
    expect(path).not.toContain("NaN");
    expect(path.startsWith("M")).toBe(true);
  });
});
