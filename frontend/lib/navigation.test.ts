import { describe, expect, it } from "vitest";

import { DESTINATIONS, destinationFor, isCurrent } from "./navigation";

describe("DESTINATIONS", () => {
  it("lists the five destinations in the order the spec fixes", () => {
    expect(DESTINATIONS.map((d) => d.label)).toEqual([
      "Overview",
      "Plans & Assistant",
      "Purchase Simulator",
      "Balance Trajectory",
      "Forecast & Data",
    ]);
  });

  it("gives every destination a route and a plain-language purpose", () => {
    for (const d of DESTINATIONS) {
      expect(d.href.startsWith("/")).toBe(true);
      expect(d.purpose.length).toBeGreaterThan(10);
    }
  });

  it("has no duplicate routes", () => {
    const hrefs = DESTINATIONS.map((d) => d.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("isCurrent", () => {
  it("marks only the matching destination", () => {
    expect(isCurrent("/plans", "/plans")).toBe(true);
    expect(isCurrent("/plans", "/")).toBe(false);
  });

  it("does not let the Overview claim every nested route", () => {
    const current = DESTINATIONS.filter((d) => isCurrent("/simulate", d.href));
    expect(current).toHaveLength(1);
    expect(current[0].label).toBe("Purchase Simulator");
  });
});

describe("destinationFor", () => {
  it("names the page the user is on", () => {
    expect(destinationFor("/trajectory")?.label).toBe("Balance Trajectory");
  });

  it("returns nothing for a route that is not a destination", () => {
    expect(destinationFor("/nowhere")).toBeUndefined();
  });
});
