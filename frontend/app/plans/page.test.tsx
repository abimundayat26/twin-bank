import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialTwin } from "@/lib/types";
import mockTwin from "@/lib/mock/twin.json";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getTwin: vi.fn(),
    getAssistantOpening: vi.fn(),
    saveGoals: vi.fn(),
    setMinimumBalance: vi.fn(),
    respondToClarification: vi.fn(),
    compileGoal: vi.fn(),
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
  vi.mocked(api.saveGoals).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.setMinimumBalance).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.respondToClarification).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.getAssistantOpening).mockResolvedValue({ questions: [] });
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
    // Named, because the Assistant's composer is a textbox on this page too.
    await waitFor(() =>
      expect(screen.getByLabelText("Describe the goal")).toBeInTheDocument(),
    );
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

/**
 * The page's wiring: each control has to reach the right call with the right
 * arguments. The controls themselves are tested beside their components.
 */
describe("Plans wiring", () => {
  it("counts the open questions before the panel that asks them", async () => {
    renderPlans();
    await waitFor(() =>
      expect(screen.getByText("TwinBank needs your answer")).toBeInTheDocument(),
    );
    expect(screen.getByText(/One detected bill could not be classified/)).toBeInTheDocument();
  });

  it("drops the banner when nothing is left to ask", async () => {
    const answered = TWIN.obligations.map((o) => ({ ...o, category_candidates: [] }));
    vi.mocked(api.getTwin).mockResolvedValue({
      data: { ...TWIN, obligations: answered },
      source: "api",
    });
    renderPlans();
    await waitFor(() => expect(screen.getByText("Upcoming obligations")).toBeInTheDocument());
    expect(screen.queryByText("TwinBank needs your answer")).not.toBeInTheDocument();
  });

  it("sends an obligation answer to the backend", async () => {
    const user = userEvent.setup();
    renderPlans();
    await waitFor(() => expect(screen.getByText("What is this?")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Savings transfer/ }));
    await waitFor(() => expect(api.respondToClarification).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.respondToClarification).mock.calls[0][1].category).toBe(
      "savings_transfer",
    );
  });

  it("saves a new minimum checking balance", async () => {
    const user = userEvent.setup();
    renderPlans();
    await waitFor(() =>
      expect(
        screen.getByLabelText("Minimum checking balance in dollars"),
      ).toBeInTheDocument(),
    );

    await user.type(screen.getByLabelText("Minimum checking balance in dollars"), "250");
    await user.click(screen.getByRole("button", { name: "Set" }));
    await waitFor(() => expect(api.setMinimumBalance).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.setMinimumBalance).mock.calls[0][1]).toEqual({ amount: 250 });
  });

  // Removing sends the whole declared set back, minus the one goal: the endpoint
  // replaces rather than appends.
  it("removes a goal without dropping the emergency reserve with it", async () => {
    const user = userEvent.setup();
    renderPlans();
    await waitFor(() => expect(screen.getByText("Summer housing")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Remove goal" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(api.saveGoals).toHaveBeenCalledTimes(1));
    const request = vi.mocked(api.saveGoals).mock.calls[0][1];
    expect(request.goals).toEqual([]);
    expect(request.constraints).toEqual(TWIN.constraints);
  });

  it("names the soonest deadline as the one that ends the simulation", async () => {
    const twoGoals = {
      ...TWIN,
      goals: [
        ...TWIN.goals,
        {
          id: "goal_later",
          name: "A later goal",
          target_amount: 500,
          deadline: "2027-11-01",
          current_amount: 0,
          provenance: "declared" as const,
        },
      ],
    };
    vi.mocked(api.getTwin).mockResolvedValue({ data: twoGoals, source: "api" });
    renderPlans();
    await waitFor(() => expect(screen.getByText("Active savings goal")).toBeInTheDocument());
    expect(screen.getByText(/The soonest deadline, which is where the simulation ends/))
      .toBeInTheDocument();
    expect(screen.getByText("Also saving for")).toBeInTheDocument();
  });

  it("says what a twin with no goals means rather than showing an empty panel", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: { ...TWIN, goals: [] }, source: "api" });
    renderPlans();
    await waitFor(() => expect(screen.getByText("Savings goals")).toBeInTheDocument());
    expect(screen.getByText(/No goals declared/)).toBeInTheDocument();
  });

  it("reports a failed save where the page can show it", async () => {
    vi.mocked(api.respondToClarification).mockRejectedValue(new Error("save rejected"));
    const user = userEvent.setup();
    renderPlans();
    await waitFor(() => expect(screen.getByText("What is this?")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Savings transfer/ }));
    await waitFor(() =>
      expect(screen.getByText("Could not save your answer")).toBeInTheDocument(),
    );
    expect(screen.getByText("save rejected")).toBeInTheDocument();
  });
});
