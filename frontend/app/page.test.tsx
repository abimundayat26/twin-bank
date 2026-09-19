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

  it("prompts for a simulation before one exists", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("intent-graph")).toBeInTheDocument());
    expect(screen.getByText(/to compare the/)).toBeInTheDocument();
  });
});
