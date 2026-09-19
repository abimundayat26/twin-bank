import { describe, expect, it } from "vitest";

import { forecastSummary, monthFactors, seasonalSummary } from "./seasonal";
import type { ForecastMetadata, SeasonalProfile } from "./types";

const FLAT: Record<string, number> = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [String(i + 1), 1]),
);

function profile(overrides: Record<string, number>): SeasonalProfile {
  return { factors: { ...FLAT, ...overrides } };
}

describe("monthFactors", () => {
  it("lists the twelve months in calendar order", () => {
    const months = monthFactors(profile({ "12": 2.34 }));
    expect(months.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(months[11]).toEqual({ month: 12, name: "December", factor: 2.34 });
  });

  it("treats a missing month as average", () => {
    expect(monthFactors({ factors: { "1": 1.5 } })[5].factor).toBe(1);
  });
});

describe("seasonalSummary", () => {
  it("names the busiest and quietest months", () => {
    expect(seasonalSummary(profile({ "12": 2.34, "4": 0.49 }))).toBe(
      "Busiest in December (2.34×), quietest in April (0.49×)",
    );
  });

  it("groups months that share a level", () => {
    expect(seasonalSummary(profile({ "8": 1.3, "9": 1.3, "12": 0.8 }))).toBe(
      "Busiest in August and September (1.30×), quietest in December (0.80×)",
    );
  });

  it("says nothing about a flat profile", () => {
    expect(seasonalSummary(profile({}))).toBeNull();
    expect(seasonalSummary(profile({ "3": 1.001 }))).toBeNull();
  });
});

describe("forecastSummary", () => {
  const forecast: ForecastMetadata = {
    method: "seasonal_ewma",
    as_of: "2026-09-18",
    window_start: "2025-09-20",
    observed_fortnights: 25,
    half_life_days: 180,
  };

  it("states the window and the recency weighting", () => {
    expect(forecastSummary(forecast)).toBe(
      "Fitted to 25 fortnights of spending, September 20, 2025 – September 18, 2026; " +
        "recent fortnights count more (180-day half-life)",
    );
  });

  it("says when every fortnight counts equally", () => {
    expect(forecastSummary({ ...forecast, method: "flat_mean", half_life_days: null })).toMatch(
      /; every fortnight counts equally$/,
    );
  });
});
