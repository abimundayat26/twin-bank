import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialTwin } from "@/lib/types";
import mockTwin from "@/lib/mock/twin.json";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, getTwin: vi.fn() };
});

// React Flow measures its canvas, which jsdom reports as 0x0, so the graph
// renders nothing useful here. Its logic is covered by lib/graph.test.ts; this
// file is about the page around it.
vi.mock("@/components/IntentGraph", () => ({
  IntentGraph: () => <div data-testid="intent-graph" />,
}));

import * as api from "@/lib/api";
import { TwinProvider } from "@/lib/state/TwinProvider";
import Home from "./page";

const TWIN = mockTwin as unknown as FinancialTwin;

function renderPage() {
  return render(
    <TwinProvider>
      <Home />
    </TwinProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
});

describe("Overview page", () => {
  it("shows a waiting state before the twin arrives", () => {
    vi.mocked(api.getTwin).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Loading Alex/)).toBeInTheDocument();
  });

  it("renders the twin once it loads", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Financial Twin$/)).toBeInTheDocument(),
    );
    expect(screen.getByTestId("intent-graph")).toBeInTheDocument();
  });

  it("explains a failed load instead of rendering an empty twin", async () => {
    vi.mocked(api.getTwin).mockRejectedValue(new Error("backend said no"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Could not load the Financial Twin")).toBeInTheDocument(),
    );
    expect(screen.getByText("backend said no")).toBeInTheDocument();
    expect(screen.queryByTestId("intent-graph")).not.toBeInTheDocument();
  });

  it("summarises goals and obligations without embedding their editors", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("intent-graph")).toBeInTheDocument());

    expect(screen.getByText("Savings goals")).toBeInTheDocument();
    expect(screen.getByText("Upcoming obligations")).toBeInTheDocument();

    // SPEC 3.1: the full compiler, the purchase form and the obligation editor
    // belong on their own pages, not here.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Simulate/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Minimum checking balance")).not.toBeInTheDocument();
  });

  it("offers a way on to the pages that do the work", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("intent-graph")).toBeInTheDocument());

    expect(screen.getByRole("link", { name: "Simulate a purchase" })).toHaveAttribute(
      "href",
      "/simulate",
    );
    expect(screen.getByRole("link", { name: "Add a goal" })).toHaveAttribute("href", "/plans");
  });

  it("shows the accounts and the total they add up to", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Current balance")).toBeInTheDocument());
    expect(screen.getByText(/Not all of this is free to spend/)).toBeInTheDocument();
  });
});
