/**
 * Plain-language readings of a twin's spending forecast: a category's seasonal
 * shape and where the figures came from. Pure functions; the twin view renders them.
 *
 * The busiest/quietest wording follows `seasonal_assumption` in
 * backend/src/backend/simulation/explain.py, so the twin view and the simulation's
 * assumptions describe a profile the same way.
 */

import { longDate } from "./format";
import type { ForecastMetadata, SeasonalProfile } from "./types";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface MonthFactor {
  /** 1-12. */
  month: number;
  name: string;
  factor: number;
}

/** The twelve months in calendar order. A month the profile leaves out is average (1.0). */
export function monthFactors(profile: SeasonalProfile): MonthFactor[] {
  return MONTHS.map((name, i) => ({ month: i + 1, name, factor: profile.factors[String(i + 1)] ?? 1 }));
}

function joinMonths(names: string[]): string {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "Busiest in December (2.34×), quietest in April (0.49×)", or null for a flat profile. */
export function seasonalSummary(profile: SeasonalProfile): string | null {
  const levels = new Map<number, string[]>();
  for (const { name, factor } of monthFactors(profile)) {
    const level = Math.round(factor * 100) / 100;
    levels.set(level, [...(levels.get(level) ?? []), name]);
  }
  if (levels.size < 2) return null;
  const high = Math.max(...levels.keys());
  const low = Math.min(...levels.keys());
  return (
    `Busiest in ${joinMonths(levels.get(high)!)} (${high.toFixed(2)}×), ` +
    `quietest in ${joinMonths(levels.get(low)!)} (${low.toFixed(2)}×)`
  );
}

/** Where the spending figures came from: the window, its size and how recent fortnights were weighted. */
export function forecastSummary(forecast: ForecastMetadata): string {
  const weighting =
    forecast.half_life_days != null
      ? `recent fortnights count more (${forecast.half_life_days}-day half-life)`
      : "every fortnight counts equally";
  return (
    `Fitted to ${forecast.observed_fortnights} fortnights of spending, ` +
    `${longDate(forecast.window_start)} – ${longDate(forecast.as_of)}; ${weighting}`
  );
}
