/** Display helpers. Formatting only — never derive a financial figure here. */

import { createElement, type ReactElement } from "react";

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const MONEY_EXACT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const SHORT_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const LONG_DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

const TRUE_MINUS = "−";

/** JavaScript's explicit form of the money rule: halves move away from zero. */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) return value;
  const rounded = Math.floor(Math.abs(value) + 0.5);
  return value < 0 ? -rounded : rounded;
}

function withTrueMinus(formatted: string): string {
  return formatted.replace("-", TRUE_MINUS);
}

export const money = (value: number) =>
  withTrueMinus(MONEY.format(roundHalfAwayFromZero(value)));

export const moneyExact = (value: number) => withTrueMinus(MONEY_EXACT.format(value));

/** Keeps the sign, e.g. "−$800" / "+$720". */
export const signedMoney = (value: number) => {
  const rounded = roundHalfAwayFromZero(value);
  const sign = rounded < 0 ? TRUE_MINUS : "+";
  return `${sign}${MONEY.format(Math.abs(rounded))}`;
};

export const percent = (probability: number) =>
  `${roundHalfAwayFromZero(probability * 100)}%`;

/** Share of simulated futures; never rounds a rare outcome to 0% or a likely one to 100%. */
export function chance(probability: number): string {
  if (probability === 0) return "0%";
  if (probability === 1) return "100%";
  if (probability > 0 && probability < 0.005) return "<1%";
  if (probability >= 0.995 && probability < 1) return ">99%";
  return percent(probability);
}

/** Threshold decisions receive the backend's raw value, never formatted text (G-4). */
export function meetsThreshold(value: number, threshold: number): boolean {
  return value >= threshold;
}

/** ISO dates are parsed as UTC so the rendered day never shifts by timezone. */
export const longDate = (iso: string) => LONG_DATE.format(new Date(`${iso}T00:00:00Z`));

export const shortDate = (iso: string) => SHORT_DATE.format(new Date(`${iso}T00:00:00Z`));

/** Date display uses the twin's reference year rather than the wall clock (G-1). */
export function twinDate(iso: string, asOf: string): string {
  const formatter = iso.slice(0, 4) === asOf.slice(0, 4) ? SHORT_DATE : new Intl.DateTimeFormat(
    "en-US",
    { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" },
  );
  return formatter.format(new Date(`${iso}T00:00:00Z`));
}

/** Accessible date primitive: the full source date is available without sight (G-1). */
export function DateText({ date, asOf }: { date: string; asOf: string }): ReactElement {
  const display = twinDate(date, asOf);
  return createElement(
    "time",
    { dateTime: date, title: date, "aria-label": `${display} (${date})` },
    display,
  );
}

/** A timestamp that already carries a zone, or is naive. */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * An ISO 8601 timestamp, rendered in UTC: "September 19, 2026 at 2:32 PM UTC".
 *
 * A zone is always shown because the reader has no other way to place the
 * instant, and a value with none is read as UTC rather than as the viewer's
 * local time, which would silently move the hour on screen. Returns null for
 * anything that is not a timestamp, so a caller omits the fact rather than
 * printing "Invalid Date".
 */
export function longDateTime(iso: string): string | null {
  const parsed = new Date(ZONED.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(parsed.getTime()) ? null : LONG_DATE_TIME.format(parsed);
}

/** 1 -> "1st". Used for `due_day`, which is a day of month, not a date. */
export function ordinalDay(day: number): string {
  const suffix =
    day % 10 === 1 && day % 100 !== 11
      ? "st"
      : day % 10 === 2 && day % 100 !== 12
        ? "nd"
        : day % 10 === 3 && day % 100 !== 13
          ? "rd"
          : "th";
  return `${day}${suffix}`;
}
