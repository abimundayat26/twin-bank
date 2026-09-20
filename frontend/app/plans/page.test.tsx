import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialTwin, GoalCompileResponse, OneTimeObligation } from "@/lib/types";
import mockTwin from "@/lib/mock/twin.json";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getTwin: vi.fn(),
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

/**
 * End to end on the page: a drafted one-time obligation used to be compiled by
 * the backend, dropped by Confirm and shown nowhere. These cover the whole path
 * — draft, review, confirm, list, remove.
 */
describe("one-time obligations", () => {
  const INSURANCE: OneTimeObligation = {
    id: "one_car_insurance",
    name: "Car insurance",
    amount: 450,
    due_date: "2026-10-15",
    account_id: "acc_checking",
    mandatory: true,
    provenance: "declared",
  };

  const DRAFT: GoalCompileResponse = {
    user_id: "alex",
    text: "I owe $450 for car insurance on October 15",
    goals: [],
    constraints: [],
    one_time_obligations: [INSURANCE],
    clarifications: [],
    unparsed: [],
    compiler: "rules",
  };

  function twinOwing(owed: OneTimeObligation[] | undefined) {
    return { ...TWIN, one_time_obligations: owed } as FinancialTwin;
  }

  // `Card` renders an unnamed <section>, so the panel is found by its subtitle.
  // The composer's review block carries its own aria-labelledby and is the only
  // named region, which is what keeps the two apart while a draft is open.
  const panel = () => screen.getByText(/Known one-off expenses you declared/).closest("section")!;
  const reviewBlock = () => screen.getByRole("region", { name: "One-time obligations" });

  async function describeOne(user: ReturnType<typeof userEvent.setup>) {
    vi.mocked(api.compileGoal).mockResolvedValue({ data: DRAFT, source: "api" });
    await user.type(
      screen.getByLabelText("Describe the goal or obligation"),
      "I owe $450 for car insurance on October 15",
    );
    await user.click(screen.getByRole("button", { name: "Read this back to me" }));
  }

  it("lists a confirmed obligation in its own panel", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: twinOwing([INSURANCE]), source: "api" });
    renderPlans();
    await waitFor(() => expect(screen.getByText("Car insurance")).toBeInTheDocument());
    expect(within(panel()).getByText("Car insurance")).toBeInTheDocument();
    expect(within(panel()).getByText("$450")).toBeInTheDocument();
  });

  // The detected recurring bills and the declared one-offs are different kinds
  // of fact and must not become one list (SPEC §3.2).
  it("keeps it out of the detected recurring panels", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: twinOwing([INSURANCE]), source: "api" });
    renderPlans();
    await waitFor(() => expect(screen.getByText("Car insurance")).toBeInTheDocument());
    const detected = screen.getByText("Mandatory bills TwinBank must cover").closest("section")!;
    expect(within(detected).queryByText("Car insurance")).not.toBeInTheDocument();
  });

  it("says plainly when none are declared", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: twinOwing([]), source: "api" });
    renderPlans();
    await waitFor(() => expect(screen.getByText(/None declared/)).toBeInTheDocument());
  });

  // An older backend omits the field entirely: "none", not a broken page.
  it("renders a twin without the field rather than failing", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: twinOwing(undefined), source: "api" });
    renderPlans();
    await waitFor(() => expect(screen.getByText(/None declared/)).toBeInTheDocument());
    expect(within(panel()).getByText(/None declared/)).toBeInTheDocument();
  });

  it("reads a drafted obligation back before anything is saved", async () => {
    const user = userEvent.setup();
    renderPlans();
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
    await describeOne(user);

    await waitFor(() => expect(reviewBlock()).toBeInTheDocument());
    expect(within(reviewBlock()).getByText("Car insurance")).toBeInTheDocument();
    // SPEC §4: nothing reaches the twin before the confirmation, and the panel
    // of confirmed ones still says there are none.
    expect(within(panel()).getByText(/None declared/)).toBeInTheDocument();
    expect(api.saveGoals).not.toHaveBeenCalled();
  });

  // The regression this whole change exists for: Confirm used to send only
  // `{ goals, constraints }`, so the drafted obligation was silently dropped.
  it("sends the drafted obligation when Confirm is pressed", async () => {
    const user = userEvent.setup();
    renderPlans();
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
    await describeOne(user);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Confirm and update my twin/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Confirm and update my twin/ }));

    await waitFor(() => expect(api.saveGoals).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveGoals).mock.calls[0][1].one_time_obligations).toEqual([INSURANCE]);
  });

  // Removing sends the whole declared set back minus that one: the endpoint
  // replaces rather than appends, so the goals have to travel with it.
  it("removes one without dropping the goals or the reserve", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: twinOwing([INSURANCE]), source: "api" });
    const user = userEvent.setup();
    renderPlans();
    await waitFor(() => expect(screen.getByText("Car insurance")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Remove Car insurance" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(api.saveGoals).toHaveBeenCalledTimes(1));
    const request = vi.mocked(api.saveGoals).mock.calls[0][1];
    expect(request.one_time_obligations).toEqual([]);
    expect(request.goals).toEqual(TWIN.goals);
    expect(request.constraints).toEqual(TWIN.constraints);
  });

  it("reports a failed removal where the page can show it", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: twinOwing([INSURANCE]), source: "api" });
    vi.mocked(api.saveGoals).mockRejectedValue(new Error("obligation save rejected"));
    const user = userEvent.setup();
    renderPlans();
    await waitFor(() => expect(screen.getByText("Car insurance")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Remove Car insurance" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(screen.getByText("obligation save rejected")).toBeInTheDocument(),
    );
  });
});
