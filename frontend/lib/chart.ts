/**
 * Geometry for the balance trajectory chart. Pure functions, no DOM, no React —
 * plucking, scaling, decimation and axis ticks only.
 *
 * Nothing here derives a financial figure. Every value plotted comes from
 * `SimulationResponse.balance_bands`, which the backend's Monte Carlo produced.
 * The only arithmetic is turning dollars into pixels.
 */

import type { BalanceBandPoint, IsoDate } from "./types";

/** Above this many points, decimate before building a path. */
export const MAX_PLOT_POINTS = 360;

/** Fraction of the value range left as breathing room above and below. */
export const Y_PAD_FRACTION = 0.06;

/** Minimum padding in dollars, so a flat projection still gets a sane axis. */
export const MIN_Y_PAD = 50;

export interface Domain {
  lo: number;
  hi: number;
}

/** One scenario's daily percentiles, as parallel arrays ready to plot. */
export interface Track {
  dates: IsoDate[];
  p10: number[];
  median: number[];
  p90: number[];
}

/**
 * The number of days safe to read from both scenarios.
 *
 * The backend builds both from one horizon, so they always match. But fixture
 * JSON is cast unchecked in `lib/api.ts`, so a hand-edited or truncated file
 * would otherwise index past the end of the shorter array and poison a path
 * with `undefined`.
 */
export function alignedLength(
  baseline?: BalanceBandPoint[] | null,
  counterfactual?: BalanceBandPoint[] | null,
): number {
  return Math.min(baseline?.length ?? 0, counterfactual?.length ?? 0);
}

/** Splits band points into parallel arrays, truncated to `count` days. */
export function toTrack(points: BalanceBandPoint[], count: number): Track {
  const kept = points.slice(0, Math.max(0, count));
  return {
    dates: kept.map((point) => point?.date),
    p10: kept.map((point) => point?.p10 ?? NaN),
    median: kept.map((point) => point?.median ?? NaN),
    p90: kept.map((point) => point?.p90 ?? NaN),
  };
}

/** Indices of the smallest and largest finite values, for decimation. */
export function extremeIndices(values: number[]): number[] {
  let lowest = -1;
  let highest = -1;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    if (lowest < 0 || value < values[lowest]) lowest = index;
    if (highest < 0 || value > values[highest]) highest = index;
  });
  return [lowest, highest].filter((index) => index >= 0);
}

/**
 * An even stride that always keeps the first day, the last day, and the given
 * extremes.
 *
 * Plain striding can drop a one-day trough, and the trough is the whole point of
 * the chart — a purchase that dips under the reserve for a single day must still
 * be visible. Returns identity when no decimation is needed.
 */
export function keepIndices(
  count: number,
  extremes: number[] = [],
  max = MAX_PLOT_POINTS,
): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, index) => index);
  const stride = Math.ceil(count / max);
  const kept = new Set<number>([0, count - 1]);
  for (const index of extremes) {
    if (index >= 0 && index < count) kept.add(index);
  }
  for (let index = 0; index < count; index += stride) kept.add(index);
  return [...kept].sort((a, b) => a - b);
}

/**
 * The value range to draw, padded.
 *
 * `extra` holds values that are not plotted as a line but must stay on screen —
 * the emergency reserve above all. Without it the reserve line falls off the
 * bottom of the plot in the default demo, where it sits just under the
 * counterfactual's lower band.
 */
export function yDomain(series: number[][], extra: number[] = []): Domain {
  const values = [...series.flat(), ...extra].filter((value) => Number.isFinite(value));
  if (!values.length) return { lo: -MIN_Y_PAD, hi: MIN_Y_PAD };
  const lo = Math.min(...values);
  let hi = Math.max(...values);
  // Underwater balances only read as underwater if zero is on the chart.
  if (lo < 0) hi = Math.max(hi, 0);
  const span = hi - lo;
  const pad = span > 0 ? span * Y_PAD_FRACTION : Math.max(MIN_Y_PAD, Math.abs(hi) * 0.05);
  return { lo: lo - pad, hi: hi + pad };
}

/** Mantissas a "nice" axis step is built from (TR-3): step = m x 10^k dollars. */
export const TICK_MANTISSAS = [1, 2, 2.5, 5];

/**
 * Whole-dollar steps in ascending order, up to an order of magnitude past `span`.
 *
 * `2.5` only earns a place from 10^1 up: a $2.50 tick would need cents, which
 * G-2 forbids, so non-integer steps are dropped rather than rounded into
 * duplicate labels.
 */
function candidateSteps(span: number): number[] {
  const steps: number[] = [];
  const maxExponent = Math.ceil(Math.log10(Math.max(span, 1))) + 1;
  for (let exponent = 0; exponent <= maxExponent; exponent += 1) {
    for (const mantissa of TICK_MANTISSAS) {
      const step = mantissa * 10 ** exponent;
      if (Number.isInteger(step)) steps.push(step);
    }
  }
  return steps.sort((a, b) => a - b);
}

/**
 * Y-axis values on a nice step, 4 to 7 of them (TR-3).
 *
 * Ticks are multiples of the step, so they read as round money (`$12,500`)
 * rather than as whatever the data's extremes happened to be, and zero always
 * lands on a tick when the plot straddles it. Among the steps that fit the tick
 * budget the one closest to the middle of that budget wins, and a tie goes to
 * the larger step, which is the sparser axis.
 *
 * This picks label positions. It does not touch a plotted value (G-6).
 */
export function niceTicks(domain: Domain, minTicks = 4, maxTicks = 7): number[] {
  const span = domain.hi - domain.lo;
  if (!Number.isFinite(span) || span <= 0) return [];

  const ticksFor = (step: number): number[] => {
    const ticks: number[] = [];
    const first = Math.ceil(domain.lo / step) * step;
    // A whole step of slack, so a float that lands a hair past `hi` is not lost.
    for (let value = first; value <= domain.hi + step * 1e-9; value += step) {
      ticks.push(Math.round(value));
    }
    return ticks;
  };

  const target = (minTicks + maxTicks) / 2;
  let best: number[] = [];
  let bestDistance = Infinity;
  let fallback: number[] = [];
  let fallbackDistance = Infinity;

  for (const step of candidateSteps(span)) {
    const ticks = ticksFor(step);
    const distance = Math.abs(ticks.length - target);
    // Ties go to the first, smallest step here: when nothing fits the budget,
    // the densest axis is the one most likely to carry a label at all.
    if (distance < fallbackDistance) {
      fallbackDistance = distance;
      fallback = ticks;
    }
    if (ticks.length < minTicks || ticks.length > maxTicks) continue;
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = ticks;
    }
  }

  // A domain too narrow for 4 whole-dollar ticks (a flat projection, or one
  // padded to less than a few dollars) gets the nearest fit instead: fewer
  // ticks than the budget asks for still beats an axis with no labels. A
  // domain narrower than the gap between two whole dollars gets nothing,
  // because no whole-dollar tick lies inside it.
  return best.length ? best : fallback;
}

/** Evenly spaced x: the engine emits one point per day, so index spacing is date spacing. */
export function makeScaleX(count: number, left: number, width: number) {
  return (index: number) => (count < 2 ? left + width / 2 : left + (index / (count - 1)) * width);
}

export function makeScaleY(domain: Domain, top: number, height: number) {
  const span = domain.hi - domain.lo;
  return (value: number) =>
    span <= 0 ? top + height / 2 : top + (1 - (value - domain.lo) / span) * height;
}

/**
 * An SVG path, skipping non-finite values.
 *
 * A single `NaN` in an `L` command blanks the entire path, so one bad point would
 * erase the whole line rather than itself.
 */
export function buildPath(
  values: number[],
  scaleX: (index: number) => number,
  scaleY: (value: number) => number,
): string {
  let path = "";
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    path += `${path ? "L" : "M"}${scaleX(index).toFixed(1)} ${scaleY(value).toFixed(1)}`;
  });
  return path;
}

/** A closed band between two same-length series, for the shaded p10-p90 fan. */
export function buildBandPath(
  upper: number[],
  lower: number[],
  scaleX: (index: number) => number,
  scaleY: (value: number) => number,
): string {
  const forward = buildPath(upper, scaleX, scaleY);
  if (!forward) return "";
  let back = "";
  for (let index = lower.length - 1; index >= 0; index -= 1) {
    const value = lower[index];
    if (!Number.isFinite(value)) continue;
    back += `L${scaleX(index).toFixed(1)} ${scaleY(value).toFixed(1)}`;
  }
  return back ? `${forward}${back}Z` : "";
}

/**
 * Positions (in kept-index space) where the month changes, thinned to `maxTicks`.
 *
 * Detected on the kept dates rather than the full series, so decimation can never
 * drop a tick and leave a label pointing at the wrong day.
 */
export function monthTickPositions(dates: IsoDate[], kept: number[], maxTicks = 8): number[] {
  const boundaries: number[] = [];
  kept.forEach((dateIndex, position) => {
    if (position === 0) return;
    const previous = dates[kept[position - 1]];
    const current = dates[dateIndex];
    if (!previous || !current) return;
    if (current.slice(0, 7) !== previous.slice(0, 7)) boundaries.push(position);
  });
  if (boundaries.length <= maxTicks) return boundaries;
  const step = Math.ceil(boundaries.length / maxTicks);
  return boundaries.filter((_, index) => index % step === 0);
}

/** Elementwise equality, used to detect a purchase that changes nothing. */
export function areIdentical(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The kept position nearest a date, or -1 when the date is outside the horizon. */
export function positionOfDate(dates: IsoDate[], kept: number[], iso: IsoDate): number {
  const first = dates[kept[0]];
  const last = dates[kept[kept.length - 1]];
  if (!first || !last || iso < first || iso > last) return -1;
  let best = -1;
  let bestGap = Infinity;
  kept.forEach((dateIndex, position) => {
    const at = dates[dateIndex];
    if (!at) return;
    // ISO dates compare lexicographically, so string distance is not meaningful;
    // compare as days instead.
    const gap = Math.abs(Date.parse(`${at}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`));
    if (gap < bestGap) {
      bestGap = gap;
      best = position;
    }
  });
  return best;
}
