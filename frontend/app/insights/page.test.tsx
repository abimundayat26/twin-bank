import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DataSource } from "@/lib/api";
import type {
  FinancialTwin,
  ForecastMetadata,
  ProcessingLineage,
  SeasonalProfile,
} from "@/lib/types";
import mockTwin from "@/lib/mock/twin.json";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, getTwin: vi.fn() };
});

import * as api from "@/lib/api";
import { TwinProvider } from "@/lib/state/TwinProvider";
import ForecastPage from "./page";

/**
 * The shipped demo twin: seasonal profiles on both spending categories and a
 * forecast block, because it is rebuilt from a year of transactions. A twin
 * without one is still a real state -- a Nessie account with a few months of
 * history -- so the tests for it pass `forecast: null` explicitly.
 */
const TWIN = mockTwin as unknown as FinancialTwin;

const EWMA: ForecastMetadata = {
  method: "seasonal_ewma",
  as_of: "2026-09-19",
  window_start: "2026-03-01",
  observed_fortnights: 14,
  half_life_days: 90,
};

/**
 * No backend populates `lineage` yet -- every twin the demo serves carries
 * null -- so the states below are built here rather than read from a fixture.
 * That is the point: the panel has to be honest about a field nothing fills in.
 */
function lineage(patch: Partial<ProcessingLineage> = {}): ProcessingLineage {
  return { location: "databricks", status: "succeeded", ...patch };
}

const FLAT_PROFILE: SeasonalProfile = {
  factors: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), 1])),
};

function twinWith(patch: Partial<FinancialTwin>): FinancialTwin {
  return { ...TWIN, ...patch };
}

function loads(twin: FinancialTwin, source: DataSource = "api") {
  vi.mocked(api.getTwin).mockResolvedValue({ data: twin, source });
}

function renderPage() {
  return render(
    <TwinProvider>
      <ForecastPage />
    </TwinProvider>,
  );
}

/** Most assertions need the twin on screen first. */
async function renderLoaded() {
  renderPage();
  await waitFor(() => expect(screen.getByText("Data source")).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  loads(TWIN);
});

describe("Forecast & Data", () => {
  it("waits for the twin rather than describing one it does not have", () => {
    vi.mocked(api.getTwin).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Loading Alex/)).toBeInTheDocument();
  });

  it("explains nothing when the twin could not load", async () => {
    vi.mocked(api.getTwin).mockRejectedValue(new Error("no backend"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Could not load the Financial Twin")).toBeInTheDocument(),
    );
    expect(screen.getByText("no backend")).toBeInTheDocument();
    expect(screen.queryByText("Data source")).not.toBeInTheDocument();
    expect(screen.queryByText("Forecast")).not.toBeInTheDocument();
  });

  it("is read-only: nothing on it can rebuild or refresh the twin", async () => {
    await renderLoaded();
    // Section 3.5: no refresh control until the backend exposes one, and no
    // simulated refresh in local state. This replaces the placeholder's own
    // "no dead controls" check.
    expect(screen.getByRole("heading", { name: "Forecast & Data" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("Data source panel", () => {
  it("reports the as-of date and how many accounts were read", async () => {
    await renderLoaded();
    expect(screen.getByText("September 18, 2026")).toBeInTheDocument();
    expect(screen.getByText("2 accounts")).toBeInTheDocument();
  });

  it("says a fixture twin is demo data, never a bank read", async () => {
    loads(twinWith({ source: "fixture" }));
    await renderLoaded();
    expect(screen.getByText(/comes? from TwinBank's demo fixture/)).toBeInTheDocument();
    expect(screen.getByText(/nothing here describes a real account/)).toBeInTheDocument();
    expect(screen.getByText("Backend connected · Demo fixture")).toBeInTheDocument();
  });

  it("names Nessie when the history was read from Nessie", async () => {
    loads(twinWith({ source: "nessie" }));
    await renderLoaded();
    expect(screen.getByText(/read from the Nessie sandbox/)).toBeInTheDocument();
    expect(screen.getByText("Backend connected · Nessie data")).toBeInTheDocument();
  });

  it("says a Databricks twin was built there, not that it is bank data", async () => {
    loads(twinWith({ source: "databricks" }));
    await renderLoaded();
    expect(screen.getByText(/uploaded copy of the demo transactions/)).toBeInTheDocument();
    expect(
      screen.getByText(/says where the work ran, not whose money it describes/),
    ).toBeInTheDocument();
  });

  it("admits it when the backend named no source", async () => {
    loads(twinWith({ source: null }));
    await renderLoaded();
    expect(screen.getByText(/did not say where this twin came from/)).toBeInTheDocument();
  });

  it("lets the offline fallback win over whatever the twin claims to be", async () => {
    loads(twinWith({ source: "nessie" }), "fixture");
    await renderLoaded();
    expect(screen.getByText(/backend could not be reached/)).toBeInTheDocument();
    expect(screen.getByText("Backend offline · Bundled example")).toBeInTheDocument();
    expect(screen.queryByText(/read from the Nessie sandbox/)).not.toBeInTheDocument();
  });
});

describe("Processing panel", () => {
  it("says the local pipeline ran when no Databricks build is reported", async () => {
    loads(twinWith({ source: "fixture" }));
    await renderLoaded();
    expect(screen.getByText("Built by the local pipeline.")).toBeInTheDocument();
    expect(screen.getByText(/No Databricks job was involved/)).toBeInTheDocument();
    expect(screen.queryByText("Built in Databricks.")).not.toBeInTheDocument();
  });

  it("names Databricks only when the twin came from there", async () => {
    loads(twinWith({ source: "databricks" }));
    await renderLoaded();
    expect(screen.getByText("Built in Databricks.")).toBeInTheDocument();
    expect(screen.queryByText("Built by the local pipeline.")).not.toBeInTheDocument();
  });

  it("says the lineage is missing rather than inventing a run for it", async () => {
    loads(twinWith({ lineage: null }));
    await renderLoaded();
    expect(screen.getByText(/reported no processing lineage with the twin/)).toBeInTheDocument();
    expect(
      screen.getByText(/metadata the backend did not send, not evidence that a run failed/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Run status")).not.toBeInTheDocument();
    expect(screen.queryByText("MLflow run")).not.toBeInTheDocument();
  });

  it("describes a published Databricks run in words, with no badge to click", async () => {
    loads(twinWith({ source: "databricks", lineage: lineage() }));
    await renderLoaded();
    expect(screen.getByText("Built in Databricks.")).toBeInTheDocument();
    expect(screen.getByText(/finished successfully/)).toBeInTheDocument();
    const status = screen.getByText("Run status").closest("li");
    expect(within(status!).getByText("Succeeded")).toBeInTheDocument();
    // Section 15.1: a planned capability wears no active-looking control.
    const panel = screen.getByText("Processing").closest("section");
    expect(within(panel!).queryByRole("button")).not.toBeInTheDocument();
    expect(within(panel!).queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps the last good twin on screen when the latest run failed", async () => {
    loads(twinWith({ source: "databricks", lineage: lineage({ status: "failed" }) }));
    await renderLoaded();
    expect(screen.getByText(/most recent run TwinBank was told about failed/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been blanked/)).toBeInTheDocument();
    const status = screen.getByText("Run status").closest("li");
    expect(within(status!).getByText("Failed")).toBeInTheDocument();
    // The twin itself is still described in full.
    expect(screen.getByText("Campus Bookstore Payroll")).toBeInTheDocument();
    expect(screen.getByText("Forecast")).toBeInTheDocument();
  });

  it("does not claim a run finished when the backend could not say", async () => {
    loads(twinWith({ source: "databricks", lineage: lineage({ status: "unknown" }) }));
    await renderLoaded();
    expect(screen.getByText(/may still be going, or its outcome was never read/)).toBeInTheDocument();
    const status = screen.getByText("Run status").closest("li");
    expect(within(status!).getByText("Not reported")).toBeInTheDocument();
    expect(screen.getByText("Campus Bookstore Payroll")).toBeInTheDocument();
  });

  it("separates a local build from where its data came from", async () => {
    loads(twinWith({ source: "databricks", lineage: lineage({ location: "local" }) }));
    await renderLoaded();
    expect(screen.getByText("Built by the local pipeline.")).toBeInTheDocument();
    expect(
      screen.getByText(/Where the work ran and where the data came from are separate facts/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No Databricks job was involved/)).not.toBeInTheDocument();
  });

  it("shows the MLflow run and its time only when they are supplied", async () => {
    loads(
      twinWith({
        source: "databricks",
        lineage: lineage({
          mlflow_run_id: "9f2c1a7b4d8e40319ab6c5d2e7f80a13",
          run_time: "2026-09-19T14:32:00Z",
        }),
      }),
    );
    await renderLoaded();
    expect(screen.getByText("9f2c1a7b4d8e40319ab6c5d2e7f80a13")).toBeInTheDocument();
    expect(screen.getByText(/September 19, 2026 at 2:32 PM UTC/)).toBeInTheDocument();
    expect(screen.queryByText(/No MLflow run was recorded/)).not.toBeInTheDocument();
  });

  it("names no tracked run when the build was not recorded in MLflow", async () => {
    loads(twinWith({ source: "databricks", lineage: lineage() }));
    await renderLoaded();
    expect(screen.getByText(/No MLflow run was recorded for this build/)).toBeInTheDocument();
    expect(screen.queryByText("MLflow run")).not.toBeInTheDocument();
    expect(screen.queryByText("Run time")).not.toBeInTheDocument();
  });

  it("refuses to print an MLflow id that is not an MLflow id", async () => {
    const smuggled = "dbfs:/Volumes/main/twin/artifacts";
    loads(twinWith({ source: "databricks", lineage: lineage({ mlflow_run_id: smuggled }) }));
    await renderLoaded();
    expect(screen.queryByText(smuggled)).not.toBeInTheDocument();
    expect(screen.getByText(/shape TwinBank does not recognize/)).toBeInTheDocument();
  });

  it("says nothing was processed when the backend could not be reached", async () => {
    loads(twinWith({ source: "databricks", lineage: lineage() }), "fixture");
    await renderLoaded();
    expect(screen.getByText("Nothing was processed for this screen.")).toBeInTheDocument();
    expect(screen.queryByText("Built in Databricks.")).not.toBeInTheDocument();
    expect(screen.queryByText("Run status")).not.toBeInTheDocument();
  });
});

describe("Detected structure panel", () => {
  it("describes income as a cadence rather than an interval in days", async () => {
    await renderLoaded();
    expect(screen.getByText("Campus Bookstore Payroll")).toBeInTheDocument();
    expect(screen.getByText(/Every 14 days · ±\$59/)).toBeInTheDocument();
  });

  it("counts the obligations by how the projection treats them", async () => {
    await renderLoaded();
    const mandatory = screen.getByText("Treated as mandatory").closest("li");
    expect(within(mandatory!).getByText("3")).toBeInTheDocument();
    const optional = screen.getByText("Recurring but optional").closest("li");
    expect(within(optional!).getByText("2")).toBeInTheDocument();
  });

  it("presents an unclassified payment as a question, not a fact", async () => {
    await renderLoaded();
    expect(screen.getByText(/One detected payment could not be classified/)).toBeInTheDocument();
    expect(screen.getByText(/possibly Savings transfer \(55%\)/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Answer these on Plans/ })).toHaveAttribute(
      "href",
      "/plans",
    );
  });

  it("stops asking once every classification is answered", async () => {
    loads(twinWith({ obligations: TWIN.obligations.map((o) => ({ ...o, category_candidates: [] })) }));
    await renderLoaded();
    expect(screen.getByText(/Nothing is waiting on you/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be classified/)).not.toBeInTheDocument();
  });

  it("names the categories left as variable spending", async () => {
    await renderLoaded();
    // Scoped: the forecast panel names the same categories beside their shapes.
    const panel = screen.getByText("Detected structure").closest("section");
    expect(within(panel!).getByText("Groceries")).toBeInTheDocument();
    expect(within(panel!).getByText("Discretionary")).toBeInTheDocument();
    expect(within(panel!).getByText("$148 / 14d")).toBeInTheDocument();
  });
});

describe("Forecast panel", () => {
  it("explains a recency-weighted seasonal fit in plain language", async () => {
    loads(twinWith({ forecast: EWMA }));
    await renderLoaded();
    expect(screen.getByText("Seasonal EWMA")).toBeInTheDocument();
    expect(screen.getByText(/Recent fortnights counted more heavily/)).toBeInTheDocument();
    expect(screen.getByText("90-day half-life")).toBeInTheDocument();
    expect(screen.getByText(/An observation 90 days old counts half as much/)).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    // The window is a fact about the data source and about the fit, so it is
    // stated in both panels.
    expect(
      screen.getAllByText("March 1, 2026 – September 19, 2026").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("explains the shipped demo twin's own forecast, not an empty state", async () => {
    // The page whose whole purpose is provenance must not open on "unavailable".
    await renderLoaded();
    expect(screen.getByText("Seasonal EWMA")).toBeInTheDocument();
    expect(screen.getByText("180-day half-life")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(
      screen.getAllByText("October 4, 2025 – September 18, 2026").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/No forecast metadata recorded/)).not.toBeInTheDocument();
  });

  it("does not imply recency weighting when every fortnight counted equally", async () => {
    loads(
      twinWith({
        forecast: { ...EWMA, method: "flat_mean", half_life_days: null },
      }),
    );
    await renderLoaded();
    expect(screen.getByText("Flat mean")).toBeInTheDocument();
    expect(screen.getByText(/no seasonal adjustment/)).toBeInTheDocument();
    expect(screen.getByText("Equal weight")).toBeInTheDocument();
    expect(screen.getByText(/Every observation in the window counted equally/)).toBeInTheDocument();
    expect(screen.queryByText(/half-life/)).not.toBeInTheDocument();
  });

  it("says plainly when no forecast metadata was recorded, and still shows the shapes", async () => {
    // A twin can carry seasonal profiles without a forecast block: a Nessie
    // account with a few months of history fits shapes it cannot yet describe.
    loads(twinWith({ forecast: null }));
    await renderLoaded();
    expect(screen.getByText("No forecast metadata recorded for this twin.")).toBeInTheDocument();
    expect(screen.getByText("Not recorded")).toBeInTheDocument();
    expect(screen.getByText(/It does not mean the figures are unseasonal/)).toBeInTheDocument();
    // Both demo categories keep their sparkline.
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByText(/Busiest in January/)).toBeInTheDocument();
    expect(screen.getByText(/Busiest in December/)).toBeInTheDocument();
  });

  it("explains what a factor means before showing twelve of them", async () => {
    await renderLoaded();
    expect(screen.getByText(/1.30× is 30% above an average fortnight/)).toBeInTheDocument();
    expect(screen.getByText(/the twelve average to 1.0/)).toBeInTheDocument();
    expect(screen.getByText(/not a promise about any particular month/)).toBeInTheDocument();
    expect(screen.getAllByText("1.63×").length).toBeGreaterThanOrEqual(1);
  });

  it("says so when the twin carries no seasonal profile at all", async () => {
    loads(
      twinWith({
        variable_spending: TWIN.variable_spending.map((b) => ({ ...b, seasonal: null })),
      }),
    );
    await renderLoaded();
    expect(screen.getByText(/No category in this twin carries a seasonal profile/)).toBeInTheDocument();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("treats an entirely flat profile as no pattern rather than drawing a flat one", async () => {
    loads(
      twinWith({
        variable_spending: TWIN.variable_spending.map((b) => ({ ...b, seasonal: FLAT_PROFILE })),
      }),
    );
    await renderLoaded();
    expect(screen.getByText(/No category in this twin carries a seasonal profile/)).toBeInTheDocument();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("names the categories with a shape and the ones without, side by side", async () => {
    const [groceries, discretionary] = TWIN.variable_spending;
    loads(
      twinWith({ variable_spending: [groceries, { ...discretionary, seasonal: null }] }),
    );
    await renderLoaded();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(
      screen.getByText(/No seasonal pattern was recorded for Discretionary/),
    ).toBeInTheDocument();
  });
});

describe("Limitations panel", () => {
  it("lists the missing forecast metadata as a limitation of the page", async () => {
    loads(twinWith({ forecast: null }));
    await renderLoaded();
    expect(
      screen.getByText(/No forecast metadata was recorded for this twin, so the estimation method/),
    ).toBeInTheDocument();
  });

  it("drops that limitation once the twin carries a forecast", async () => {
    loads(twinWith({ forecast: EWMA }));
    await renderLoaded();
    expect(screen.queryByText(/No forecast metadata was recorded/)).not.toBeInTheDocument();
  });

  it("names the categories with no reliable seasonal pattern", async () => {
    const [groceries, discretionary] = TWIN.variable_spending;
    loads(twinWith({ variable_spending: [groceries, { ...discretionary, seasonal: null }] }));
    await renderLoaded();
    expect(
      screen.getByText(/found no reliable seasonal pattern for Discretionary/),
    ).toBeInTheDocument();
  });

  it("says the lineage field arrived empty rather than that no endpoint exists", async () => {
    loads(twinWith({ lineage: null }));
    await renderLoaded();
    expect(screen.getByText(/No processing lineage came with this twin/)).toBeInTheDocument();
  });

  it("drops that limitation once a run is named, and keeps the ones still true", async () => {
    loads(
      twinWith({
        lineage: lineage({ mlflow_run_id: "9f2c1a7b4d8e40319ab6c5d2e7f80a13" }),
      }),
    );
    await renderLoaded();
    expect(screen.queryByText(/No processing lineage came with this twin/)).not.toBeInTheDocument();
    expect(screen.queryByText(/was not recorded in MLflow/)).not.toBeInTheDocument();
  });

  it("names an untracked run and an unreported outcome as the gaps they are", async () => {
    loads(twinWith({ lineage: lineage({ status: "unknown" }) }));
    await renderLoaded();
    expect(screen.getByText(/did not report how that run finished/)).toBeInTheDocument();
    expect(screen.getByText(/was not recorded in MLflow/)).toBeInTheDocument();
  });

  it("states that demo figures are not a real account", async () => {
    loads(twinWith({ source: "fixture" }));
    await renderLoaded();
    expect(screen.getByText(/They are shaped like bank data; they did not come from a bank/)).toBeInTheDocument();
  });

  it("says an unconfirmed origin is unconfirmed", async () => {
    loads(twinWith({ source: null }));
    await renderLoaded();
    expect(screen.getByText(/its origin cannot be confirmed on this page/)).toBeInTheDocument();
  });

  it("counts the unanswered classifications the projection is working around", async () => {
    await renderLoaded();
    expect(screen.getByText(/One payment is still unclassified/)).toBeInTheDocument();
  });

  it("promises the browser never receives credentials or transactions", async () => {
    await renderLoaded();
    expect(
      screen.getByText(/never transactions, credentials or connection settings/),
    ).toBeInTheDocument();
  });
});
