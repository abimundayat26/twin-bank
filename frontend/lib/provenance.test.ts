import { describe, expect, it } from "vitest";

import { explanationSourceLabel, provenanceLabel, replySourceLabel } from "./provenance";
import type { FinancialTwin } from "./types";

const KNOWN_SOURCES: NonNullable<FinancialTwin["source"]>[] = [
  "nessie",
  "fixture",
  "databricks",
];

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

  it("names a twin the Databricks job built", () => {
    expect(provenanceLabel("api", "databricks")).toEqual({
      backend: "Backend connected",
      data: "Databricks build",
      label: "Backend connected · Databricks build",
      tone: "caution",
    });
  });

  it("does not mistake a Databricks twin for a source it does not know", () => {
    // The regression this module had: "databricks" reached the UI as
    // "Data source unavailable", so a working integration looked broken.
    expect(provenanceLabel("api", "databricks")?.data).not.toBe("Data source unavailable");
  });

  it("does not let a Databricks build read as live bank data", () => {
    // The job's documented input is uploaded demo transactions, not a bank.
    const shown = provenanceLabel("api", "databricks");
    expect(shown?.label).not.toContain("Nessie");
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

  it("never names a build source while the backend is unreachable", () => {
    const shown = provenanceLabel("fixture", "databricks");
    expect(shown?.label).toBe("Backend offline · Bundled example");
    expect(shown?.label).not.toContain("Databricks");
  });

  it("renders nothing until the first load resolves", () => {
    expect(provenanceLabel(undefined, null)).toBeNull();
    for (const source of KNOWN_SOURCES) {
      expect(provenanceLabel(undefined, source)).toBeNull();
    }
  });

  it("gives every source the backend can report a name of its own", () => {
    const named = KNOWN_SOURCES.map((source) => provenanceLabel("api", source)?.data);
    expect(named).not.toContain("Data source unavailable");
    expect(named).not.toContain(undefined);
    expect(new Set(named).size).toBe(KNOWN_SOURCES.length);
  });

  it("always separates reachability from data origin", () => {
    const cases = [
      ...KNOWN_SOURCES.map((source) => provenanceLabel("api", source)),
      provenanceLabel("api", null),
      provenanceLabel("fixture", null),
    ];
    for (const shown of cases) {
      expect(shown).not.toBeNull();
      expect(shown?.label).toBe(`${shown?.backend} · ${shown?.data}`);
    }
  });
});

describe("replySourceLabel", () => {
  it("names each of the three sources distinctly", () => {
    const labels = [replySourceLabel("rules"), replySourceLabel("llm"), explanationSourceLabel()];
    expect(labels).toEqual(["Rule-based", "Model-assisted", "Deterministic template"]);
    expect(new Set(labels).size).toBe(3);
  });

  it("says unavailable rather than guessing when the backend said nothing", () => {
    expect(replySourceLabel(undefined)).toBe("Source unavailable");
    expect(replySourceLabel(null)).toBe("Source unavailable");
  });

  it("never falls back to claiming a model wrote it", () => {
    // frontend/SPEC.md section 4: rules- or template-generated output must not be
    // represented as model-generated output. An unknown compiler is not a model.
    const unknown = replySourceLabel("gpt" as never);
    expect(unknown).toBe("Source unavailable");
    expect(unknown).not.toContain("Model");
  });
});
