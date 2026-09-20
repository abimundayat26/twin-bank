import { describe, expect, it } from "vitest";

import {
  chance,
  displayDate,
  longDate,
  longDateTime,
  money,
  ordinalDay,
  shortDate,
  signedMoney,
} from "./format";

describe("money", () => {
  it("rounds to whole dollars", () => {
    expect(money(1339.6)).toBe("$1,340");
  });

  it("keeps the sign", () => {
    expect(signedMoney(-800)).toBe("-$800");
    expect(signedMoney(720)).toBe("+$720");
  });
});

describe("chance", () => {
  it("never rounds a rare outcome to 0% or a likely one to 100%", () => {
    expect(chance(0.003)).toBe("<1%");
    expect(chance(0.997)).toBe(">99%");
  });

  it("shows impossible and certain outcomes exactly", () => {
    expect(chance(0)).toBe("0%");
    expect(chance(1)).toBe("100%");
    expect(chance(0.24)).toBe("24%");
  });
});

describe("dates", () => {
  it("does not shift the day by timezone", () => {
    expect(longDate("2026-09-20")).toBe("September 20, 2026");
    expect(shortDate("2026-10-01")).toBe("Oct 1");
  });
});

describe("ordinalDay", () => {
  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [21, "21st"],
    [22, "22nd"],
    [31, "31st"],
  ])("%i -> %s", (day, expected) => {
    expect(ordinalDay(day)).toBe(expected);
  });
});

describe("longDateTime", () => {
  it("renders a run timestamp in UTC, with the zone shown", () => {
    expect(longDateTime("2026-09-19T14:32:00Z")).toBe("September 19, 2026 at 2:32 PM UTC");
  });

  it("keeps the instant when the timestamp carries an offset", () => {
    expect(longDateTime("2026-09-19T16:32:00+02:00")).toBe("September 19, 2026 at 2:32 PM UTC");
  });

  it("reads a zoneless timestamp as UTC rather than as the viewer's local time", () => {
    expect(longDateTime("2026-09-19T14:32:00")).toBe("September 19, 2026 at 2:32 PM UTC");
  });

  it("returns null for something that is not a timestamp", () => {
    expect(longDateTime("whenever")).toBeNull();
  });
});

describe("displayDate", () => {
  it("drops the year inside the twin's own year and keeps it outside (G-1)", () => {
    expect(displayDate("2026-10-15", "2026-09-18")).toBe("Oct 15");
    expect(displayDate("2027-05-01", "2026-09-18")).toBe("May 1, 2027");
  });

  it("measures against the twin's as_of, not today (A1)", () => {
    // The same date reads differently for two twins, and never depends on when
    // the test is run.
    expect(displayDate("2027-05-01", "2027-01-02")).toBe("May 1");
    expect(displayDate("2026-12-31", "2027-01-02")).toBe("December 31, 2026");
  });
});
