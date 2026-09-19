import { describe, expect, it } from "vitest";

import { provenanceLabel } from "./provenance";

describe("provenanceLabel", () => {
  it("names Nessie only when the backend said the twin came from Nessie", () => {
    expect(provenanceLabel("api", "nessie")).toEqual({
      backend: "Backend connected",
      data: "Nessie data",
      label: "Backend connected · Nessie data",
      tone: "good",
    });
  });

  it("calls a connected backend's fixture twin a demo fixture, not live data", () => {
    const shown = provenanceLabel("api", "fixture");
    expect(shown?.label).toBe("Backend connected · Demo fixture");
    expect(shown?.tone).toBe("caution");
  });

  it("admits the source is unavailable when the backend named none", () => {
    expect(provenanceLabel("api", null)?.label).toBe(
      "Backend connected · Data source unavailable",
    );
    expect(provenanceLabel("api", undefined)?.label).toBe(
      "Backend connected · Data source unavailable",
    );
  });

  it("reports the offline fallback as a bundled example", () => {
    expect(provenanceLabel("fixture", null)).toEqual({
      backend: "Backend offline",
      data: "Bundled example",
      label: "Backend offline · Bundled example",
      tone: "caution",
    });
  });

  it("never claims Nessie data while the backend is unreachable", () => {
    // A stale twin may still carry source "nessie"; what is on screen is the
    // bundled fixture, so the fallback wording wins.
    const shown = provenanceLabel("fixture", "nessie");
    expect(shown?.label).toBe("Backend offline · Bundled example");
    expect(shown?.label).not.toContain("Nessie");
  });

  it("renders nothing until the first load resolves", () => {
    expect(provenanceLabel(undefined, null)).toBeNull();
    expect(provenanceLabel(undefined, "nessie")).toBeNull();
  });

  it("always separates reachability from data origin", () => {
    const cases = [
      provenanceLabel("api", "nessie"),
      provenanceLabel("api", "fixture"),
      provenanceLabel("api", null),
      provenanceLabel("fixture", null),
    ];
    for (const shown of cases) {
      expect(shown).not.toBeNull();
      expect(shown?.label).toBe(`${shown?.backend} · ${shown?.data}`);
    }
  });
});
