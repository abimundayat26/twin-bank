import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialTwin, ForecastPayload } from "@/lib/types";
import mockForecast from "@/lib/mock/forecast.json";
import mockTwin from "@/lib/mock/twin.json";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, getTwin: vi.fn(), getForecast: vi.fn() };
});

import * as api from "@/lib/api";
import { TwinProvider } from "@/lib/state/TwinProvider";
import ForecastPage from "./page";

const TWIN = mockTwin as unknown as FinancialTwin;
const FORECAST = mockForecast as unknown as ForecastPayload;

function renderPage() {
  return render(<TwinProvider><ForecastPage /></TwinProvider>);
}

function loads(twin: FinancialTwin = TWIN, source: api.DataSource = "api") {
  vi.mocked(api.getTwin).mockResolvedValue({ data: twin, source });
  vi.mocked(api.getForecast).mockResolvedValue({ data: FORECAST, source });
}

beforeEach(() => {
  vi.clearAllMocks();
  loads();
});

describe("Forecast & Data", () => {
  it("renders sections in the required order", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Forecast & Data" });
    await screen.findByRole("img", { name: /Projected total balance/ });
    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings.indexOf("Linked accounts & sources")).toBeLessThan(headings.indexOf("Financial structure"));
    expect(headings.indexOf("Financial structure")).toBeLessThan(headings.indexOf("Forecast chart"));
  });

  it("shows a stable skeleton while the twin or forecast is loading", async () => {
    vi.mocked(api.getTwin).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByLabelText("Loading Forecast & Data")).toBeInTheDocument();
  });

  it("lists accounts and only the permitted source and lineage summary", async () => {
    const twin = {
      ...TWIN,
      source: "databricks" as const,
      lineage: {
        location: "databricks" as const,
        status: "succeeded" as const,
        mlflow_run_id: "0123456789abcdef0123456789abcdef",
      },
    };
    loads(twin);
    renderPage();
    await screen.findByText("Processed in Databricks");
    expect(screen.getByText("Everyday Checking")).toBeInTheDocument();
    expect(screen.getByText("checking")).toBeInTheDocument();
    expect(screen.getByText("$1,340")).toBeInTheDocument();
    expect(screen.getByText("Processed in Databricks, succeeded")).toBeInTheDocument();
    expect(screen.queryByText("0123456789abcdef0123456789abcdef")).not.toBeInTheDocument();
  });

  it("shows income cadence, active bills in due-day order, and seasonal trends", async () => {
    renderPage();
    await screen.findByText("$725 every 14 days");
    expect(screen.getByText(/Next:/)).toHaveTextContent("Next: Sep 25");
    const bills = screen.getByText("Fixed bill schedule").closest("section")!;
    const names = within(bills).getAllByRole("listitem").map((item) => item.textContent);
    expect(names[0]).toContain("Hokie Property Mgmt Rent");
    expect(names[0]).toContain("on the 1st");
    const seasonal = screen.getByText("Seasonal trends").closest("section")!;
    const trends = within(seasonal).getAllByRole("listitem");
    expect(trends[0]).toHaveTextContent("Groceries runs busiest in Jan (+63%) and quietest in Jul (−40%).");
    expect(trends[1]).toHaveTextContent("Discretionary runs busiest in Dec (+134%) and quietest in Apr (−51%).");
  });

  it("shows honest empty states", async () => {
    loads({ ...TWIN, accounts: [], income: [], obligations: [], variable_spending: [] });
    vi.mocked(api.getForecast).mockResolvedValue({
      data: { ...FORECAST, bands: { total: [], checking: [] }, callouts: [] },
      source: "api",
    });
    renderPage();
    await screen.findByText("No linked accounts yet.");
    expect(screen.getByText("No income cadence detected yet.")).toBeInTheDocument();
    expect(screen.getByText("No active recurring bills yet.")).toBeInTheDocument();
    expect(screen.getByText("No seasonal pattern found yet.")).toBeInTheDocument();
    expect(await screen.findByText("No projection available.")).toBeInTheDocument();
  });

  it("draws the median and band with keyboard-accessible callouts and a text equivalent", async () => {
    renderPage();
    await screen.findByRole("img", { name: /10th to 90th percentile/ });
    const [node] = screen.getAllByRole("button", { name: /Low:.*due.*\$/ });
    const label = FORECAST.callouts![0].label;
    expect(screen.getAllByText(label)).toHaveLength(1);
    fireEvent.focus(node);
    expect(screen.getAllByText(label)).toHaveLength(2);
    expect(screen.getByRole("list", { name: "Forecast callouts" })).toBeInTheDocument();
  });

  it("uses the generated mock forecast and labels its figures when offline", async () => {
    loads(TWIN, "fixture");
    renderPage();
    await screen.findByText("Sample figures");
    expect(api.getForecast).toHaveBeenCalledWith("alex");
  });

  it("shows backend detail with Retry and retries only that card", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getForecast)
      .mockRejectedValueOnce(new Error("Twin has no accounts"))
      .mockResolvedValueOnce({ data: FORECAST, source: "api" });
    renderPage();
    await screen.findByText("Twin has no accounts");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("img", { name: /Projected total balance/ });
    expect(api.getForecast).toHaveBeenCalledTimes(2);
  });

  it("does not render raw confidence, uncertainty, or MLflow data", async () => {
    renderPage();
    await screen.findByRole("img", { name: /Projected total balance/ });
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/uncertainty/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/MLflow/i)).not.toBeInTheDocument();
  });
});
