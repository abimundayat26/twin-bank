import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import mockOverview from "@/lib/mock/overview.json";
import mockTwin from "@/lib/mock/twin.json";
import type { FinancialTwin, OverviewPayload } from "@/lib/types";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, getTwin: vi.fn(), getOverview: vi.fn() };
});

import * as api from "@/lib/api";
import { TwinProvider } from "@/lib/state/TwinProvider";
import Home from "./page";

const TWIN = mockTwin as unknown as FinancialTwin;
const OVERVIEW: OverviewPayload = {
  user_id: "alex",
  as_of: "2026-09-18",
  total_balance: 9876.4,
  monthly_net_cash_flow: -125.5,
  goal_progress: 0.423,
  accounts: [
    { id: "checking", name: "Main checking", balance: 5555 },
    { id: "savings", name: "Vacation savings", balance: 4321.4 },
  ],
  spending: [
    { label: "Fixed bills", monthly_amount: 900 },
    { label: "Food", monthly_amount: 300 },
  ],
  total_monthly_spending: 1200,
  upcoming: [
    { name: "Payday", amount: 700, date: "2026-10-15", kind: "income" },
    { name: "Annual fee", amount: -90, date: "2027-01-01", kind: "one_time_bill" },
  ],
};

function renderPage() {
  return render(
    <TwinProvider>
      <Home />
    </TwinProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getTwin).mockReset();
  vi.mocked(api.getOverview).mockReset();
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.getOverview).mockResolvedValue({ data: OVERVIEW, source: "api" });
});

describe("Overview page", () => {
  it("shows card-shaped skeletons while data is loading", () => {
    vi.mocked(api.getTwin).mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByRole("status", { name: "Loading overview" })).toBeInTheDocument();
    expect(screen.getByText("Loading overview…")).toHaveClass("sr-only");
  });

  it("renders KPI, account, spending, and upcoming values from the online API payload", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(api.getOverview).toHaveBeenCalledWith("alex");
    expect(screen.getByText("Total net balance")).toBeInTheDocument();
    expect(screen.getByText("$9,876")).toBeInTheDocument();
    expect(screen.getByText("−$126")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("Main checking")).toBeInTheDocument();
    expect(screen.getByText("$5,555")).toBeInTheDocument();
    expect(screen.getByText("Vacation savings")).toBeInTheDocument();
    expect(screen.getByText("$4,321")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Spending legend" })).toBeInTheDocument();
    expect(screen.getByText("$1,200")).toBeInTheDocument();
    expect(screen.getByText("Payday")).toBeInTheDocument();
    expect(screen.getByText("+$700")).toBeInTheDocument();
    expect(screen.getByText("Annual fee")).toBeInTheDocument();
    expect(screen.getByText("−$90")).toBeInTheDocument();
  });

  it("uses only the generated overview fixture when central state is offline", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "fixture" });
    renderPage();

    expect(await screen.findByText("$3,140")).toBeInTheDocument();
    expect(screen.getByText("Verizon Wireless")).toBeInTheDocument();
    expect(api.getOverview).not.toHaveBeenCalled();
  });

  it("shows an API detail and does not silently replace it with the mock", async () => {
    vi.mocked(api.getOverview).mockRejectedValue(
      new api.ApiError("Overview is unavailable for this twin", 503),
    );
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Overview is unavailable for this twin",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Verizon Wireless")).not.toBeInTheDocument();
  });

  it("requests the Overview again when Retry is pressed", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getOverview)
      .mockRejectedValueOnce(new api.ApiError("Try again", 500))
      .mockResolvedValueOnce({ data: OVERVIEW, source: "api" });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Main checking")).toBeInTheDocument();
    expect(api.getOverview).toHaveBeenCalledTimes(2);
  });

  it("links a no-goal state to Plans", async () => {
    vi.mocked(api.getOverview).mockResolvedValue({
      data: { ...OVERVIEW, goal_progress: null },
      source: "api",
    });
    renderPage();

    expect(await screen.findByRole("link", { name: "No goals yet" })).toHaveAttribute(
      "href",
      "/plans",
    );
  });

  it("shows the exact no-upcoming state", async () => {
    vi.mocked(api.getOverview).mockResolvedValue({
      data: { ...OVERVIEW, upcoming: [] },
      source: "api",
    });
    renderPage();

    expect(
      await screen.findByText("Nothing due in the next 30 days."),
    ).toBeInTheDocument();
  });

  it("shows only the no-account card when there are no accounts", async () => {
    vi.mocked(api.getOverview).mockResolvedValue({
      data: { ...OVERVIEW, accounts: [] },
      source: "api",
    });
    renderPage();

    expect(await screen.findByText("No accounts yet")).toBeInTheDocument();
    expect(screen.queryByText("Total net balance")).not.toBeInTheDocument();
    expect(screen.queryByText("Spending")).not.toBeInTheDocument();
    expect(screen.queryByText("Upcoming activity")).not.toBeInTheDocument();
  });

  it("exposes the full ISO date while displaying the twin-relative short date", async () => {
    renderPage();

    const sameYear = await screen.findByLabelText("Oct 15 (2026-10-15)");
    expect(sameYear).toHaveTextContent("Oct 15");
    expect(sameYear).toHaveAttribute("title", "2026-10-15");
    expect(screen.getByLabelText("Jan 1, 2027 (2027-01-01)")).toHaveAttribute(
      "dateTime",
      "2027-01-01",
    );
  });

  it("provides every donut value in a screen-reader table", async () => {
    renderPage();

    const table = await screen.findByRole("table", { name: "Spending breakdown" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(table).getByRole("rowheader", { name: "Fixed bills" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "Food" })).toBeInTheDocument();
    expect(within(table).getByText("$900")).toBeInTheDocument();
    expect(within(table).getByText("$300")).toBeInTheDocument();
  });

  it("keeps long account and activity names in wrapping containers", async () => {
    const longName = "A very long account name that must remain readable on a narrow screen";
    vi.mocked(api.getOverview).mockResolvedValue({
      data: {
        ...OVERVIEW,
        accounts: [{ id: "long", name: longName, balance: 10 }],
        upcoming: [{ name: longName, amount: -10, date: "2026-10-01", kind: "recurring_bill" }],
      },
      source: "api",
    });
    renderPage();

    await waitFor(() => expect(screen.getAllByText(longName)).toHaveLength(2));
    for (const name of screen.getAllByText(longName)) expect(name).toHaveClass("break-words");
  });
});

describe("generated offline Overview payload", () => {
  it("has the contract shape used by the page", () => {
    const fixture = mockOverview as OverviewPayload;
    expect(fixture.user_id).toBe("alex");
    expect(fixture.accounts.length).toBeGreaterThan(0);
    expect(fixture.total_monthly_spending).toBeGreaterThan(0);
  });
});
