/** Display helpers. Formatting only — never derive a financial figure here. */

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

export const money = (value: number) => MONEY.format(value);

export const moneyExact = (value: number) => MONEY_EXACT.format(value);

/** Keeps the sign, e.g. "-$800" / "+$720". */
export const signedMoney = (value: number) =>
  `${value < 0 ? "-" : "+"}${MONEY.format(Math.abs(value))}`;

export const percent = (probability: number) => `${Math.round(probability * 100)}%`;

/** ISO dates are parsed as UTC so the rendered day never shifts by timezone. */
export const longDate = (iso: string) => LONG_DATE.format(new Date(`${iso}T00:00:00Z`));

export const shortDate = (iso: string) => SHORT_DATE.format(new Date(`${iso}T00:00:00Z`));

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
