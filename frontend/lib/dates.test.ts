import { describe, expect, it } from "vitest";

import { addDays } from "./dates";

describe("addDays", () => {
  it("rolls over a month and a year", () => {
    expect(addDays("2026-09-18", 1)).toBe("2026-09-19");
    expect(addDays("2026-09-18", 30)).toBe("2026-10-18");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("counts backwards", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("knows which Februaries have 29 days", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  });

  // G-11's two-year limit, and the horizon the engine enforces.
  it("lands on the same day of the month two years out", () => {
    expect(addDays("2026-09-18", 730)).toBe("2028-09-17");
  });
});
