import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialTwin } from "@/lib/types";
import mockTwin from "@/lib/mock/twin.json";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, getTwin: vi.fn() };
});

import * as api from "@/lib/api";
import { TwinProvider } from "@/lib/state/TwinProvider";
import PlansPage from "./page";

const TWIN = mockTwin as unknown as FinancialTwin;

function renderPlans() {
  return render(
    <TwinProvider>
      <PlansPage />
    </TwinProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
});

describe("Plans & Assistant", () => {
  it("waits for the twin before showing anything to declare", () => {
    vi.mocked(api.getTwin).mockReturnValue(new Promise(() => {}));
    renderPlans();
    expect(screen.getByText(/Loading Alex/)).toBeInTheDocument();
  });

  it("keeps goals and obligations in separate labelled panels", async () => {
    renderPlans();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Goals and limits" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("region", { name: "Obligations" })).toBeInTheDocument();
  });

  it("carries the goal composer, which the Overview no longer has", async () => {
    renderPlans();
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
  });

  it("shows the declared goals and the limits they sit on top of", async () => {
    renderPlans();
    await waitFor(() =>
      expect(screen.getByText("Active savings goal")).toBeInTheDocument(),
    );
    expect(screen.getByText("Minimum emergency reserve")).toBeInTheDocument();
  });

  it("groups obligations rather than listing them undifferentiated", async () => {
    renderPlans();
    await waitFor(() =>
      expect(screen.getByText("Upcoming obligations")).toBeInTheDocument(),
    );
    expect(screen.getByText("Recurring expenses")).toBeInTheDocument();
  });

  it("says which operations need the backend when the twin could not load", async () => {
    vi.mocked(api.getTwin).mockRejectedValue(new Error("no backend"));
    renderPlans();
    await waitFor(() =>
      expect(screen.getByText("Could not load your plans")).toBeInTheDocument(),
    );
    expect(screen.getByText(/need the backend/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
