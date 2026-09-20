/** Calendar arithmetic on ISO dates. No formatting, no financial figures. */

/**
 * `iso` moved by `days`, as an ISO date.
 *
 * Parsed as UTC, like every other date in the app: a local-time parse would
 * shift the day for anyone west of Greenwich and silently move a deadline.
 */
export function addDays(iso: string, days: number): string {
  const shifted = new Date(`${iso}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}
