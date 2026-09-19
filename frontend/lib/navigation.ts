/**
 * The top-level destinations, in the order SPEC section 2.1 fixes.
 *
 * Each page has one job, so the user never scrolls past unrelated features to
 * reach the one they came for. Plain data, kept out of the nav component so the
 * order and the current-page matching can be tested without a DOM.
 */

export interface Destination {
  href: string;
  label: string;
  /** One line, shown as the nav item's description and on the empty pages. */
  purpose: string;
}

export const DESTINATIONS: Destination[] = [
  {
    href: "/",
    label: "Overview",
    purpose: "Accounts, the Financial Intent Graph, goals and obligations at a glance.",
  },
  {
    href: "/plans",
    label: "Plans & Assistant",
    purpose: "Declare goals and constraints, and answer questions about detected bills.",
  },
  {
    href: "/simulate",
    label: "Purchase Simulator",
    purpose: "Enter a purchase and compare the future with it against the future without it.",
  },
  {
    href: "/trajectory",
    label: "Balance Trajectory",
    purpose: "The projection behind the last simulation, with its bands and assumptions.",
  },
  {
    href: "/insights",
    label: "Forecast & Data",
    purpose: "Where the twin's observed half came from and how the forecast was made.",
  },
];

/**
 * Exact matching, not prefix matching: every destination would otherwise sit
 * "inside" the Overview at "/" and two items would claim to be current.
 */
export function isCurrent(pathname: string, href: string): boolean {
  return pathname === href;
}

export function destinationFor(pathname: string): Destination | undefined {
  return DESTINATIONS.find((d) => isCurrent(pathname, d.href));
}
