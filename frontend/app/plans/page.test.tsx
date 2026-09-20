import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialTwin } from "@/lib/types";
import mockTwin from "@/lib/mock/twin.json";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getTwin: vi.fn(),
    getAssistantOpening: vi.fn(),
    updateGoal: vi.fn(),
    deleteGoal: vi.fn(),
    setReserve: vi.fn(),
    setMinimumBalance: vi.fn(),
    respondToClarification: vi.fn(),
  };
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
  vi.clearAllMocks();
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.getAssistantOpening).mockResolvedValue({ questions: [] });
});

describe("Plans & Assistant", () => {
  it("waits for the twin before showing anything to declare", () => {
    vi.mocked(api.getTwin).mockReturnValue(new Promise(() => {}));
    renderPlans();
    expect(screen.getByText(/Loading Alex/)).toBeInTheDocument();
  });

  it("opens with the Assistant, which drafts but never writes (section 9.2)", async () => {
    renderPlans();
    await waitFor(() =>
      expect(screen.getByLabelText("Message the Assistant")).toBeInTheDocument(),
    );
    expect(screen.getByRole("log", { name: "Assistant conversation" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "It drafts and asks. Nothing reaches your Financial Twin until you accept it.",
      ),
    ).toBeInTheDocument();
  });

  it("puts the Goals & Limits panel beside the chat (PL-9)", async () => {
    renderPlans();
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Goals and limits" })).toBeInTheDocument(),
    );
    expect(screen.getByText("Summer housing")).toBeInTheDocument();
    expect(screen.getByText("Emergency reserve")).toBeInTheDocument();
  });

  /**
   * PL-13. Obligations, accounts and forecasts each have their own page; a
   * side-panel that grew a copy of them would be the second dashboard the
   * minimalist layout exists to prevent.
   */
  it("keeps everything but goals and limits off this page (PL-13)", async () => {
    renderPlans();
    await waitFor(() => expect(screen.getByText("Goals")).toBeInTheDocument());
    expect(screen.queryByText("Recurring expenses")).not.toBeInTheDocument();
    expect(screen.queryByText("Upcoming obligations")).not.toBeInTheDocument();
    expect(screen.queryByText("What is this?")).not.toBeInTheDocument();
  });

  /** PL-10: a goal is typed into the chat, never added from a button here. */
  it("offers no way to create a goal outside the chat (PL-10)", async () => {
    renderPlans();
    await waitFor(() => expect(screen.getByText("Goals")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /New goal/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Describe the goal")).not.toBeInTheDocument();
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
