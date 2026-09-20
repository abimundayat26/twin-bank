/**
 * The Goals & Limits panel: PL-9 to PL-13, and the global rules an editable
 * panel has to keep (G-10 offline, G-12 explicit commit, G-16 stale write).
 */

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
    updateGoal: vi.fn(),
    deleteGoal: vi.fn(),
    setReserve: vi.fn(),
    setMinimumBalance: vi.fn(),
  };
});

import * as api from "@/lib/api";
import { GoalsLimitsPanel } from "./GoalsLimitsPanel";
import { TwinProvider } from "@/lib/state/TwinProvider";

const TWIN = mockTwin as unknown as FinancialTwin;
const GOAL = TWIN.goals[0];
const OFFLINE_REASON = "Backend offline. Showing saved sample data. Changes are disabled.";

function renderPanel() {
  return render(
    <TwinProvider>
      <GoalsLimitsPanel />
    </TwinProvider>,
  );
}

/** Opens a click-to-edit field and hands back its input. */
async function openField(user: ReturnType<typeof userEvent.setup>, label: string, owner: string) {
  await user.click(await screen.findByRole("button", { name: `Edit ${label} for ${owner}` }));
  return screen.getByLabelText(
    `${label.charAt(0).toUpperCase() + label.slice(1)} for ${owner}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.updateGoal).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.deleteGoal).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.setReserve).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.setMinimumBalance).mockResolvedValue({ data: TWIN, source: "api" });
});

describe("Goals section (PL-9, PL-10, PL-12)", () => {
  it("shows each goal's name, target, date and progress", async () => {
    renderPanel();
    expect(await screen.findByText(GOAL.name)).toBeInTheDocument();
    expect(screen.getByText("Target amount")).toBeInTheDocument();
    expect(screen.getByText("Target date")).toBeInTheDocument();
    expect(screen.getByText("Saved so far")).toBeInTheDocument();
  });

  it("orders goals by deadline, soonest first", async () => {
    const twoGoals = {
      ...TWIN,
      goals: [
        {
          id: "goal_later",
          name: "A later goal",
          target_amount: 500,
          deadline: "2027-11-01",
          current_amount: 0,
          provenance: "declared" as const,
        },
        GOAL,
      ],
    };
    vi.mocked(api.getTwin).mockResolvedValue({ data: twoGoals, source: "api" });
    renderPanel();
    const names = await screen.findAllByRole("listitem");
    expect(names[0]).toHaveTextContent(GOAL.name);
    expect(names[1]).toHaveTextContent("A later goal");
  });

  /** PL-10: partial, so a stale panel cannot overwrite the user's other goals. */
  it("saves a target amount with PATCH, not the replace-all PUT", async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = await openField(user, "target amount", GOAL.name);
    await user.clear(input);
    await user.type(input, "2500{Enter}");

    await waitFor(() => expect(api.updateGoal).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateGoal).mock.calls[0].slice(0, 3)).toEqual([
      TWIN.user_id,
      GOAL.id,
      { target_amount: 2500 },
    ]);
  });

  it("saves a target date", async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = await openField(user, "target date", GOAL.name);
    await user.clear(input);
    await user.type(input, "2027-04-01{Enter}");

    await waitFor(() => expect(api.updateGoal).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateGoal).mock.calls[0][2]).toEqual({ deadline: "2027-04-01" });
  });

  it("saves what the user has put aside, which TwinBank never infers (A4)", async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = await openField(user, "saved so far", GOAL.name);
    await user.clear(input);
    await user.type(input, "300{Enter}");

    await waitFor(() => expect(api.updateGoal).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateGoal).mock.calls[0][2]).toEqual({ current_amount: 300 });
  });

  it("deletes one goal, and only after a confirm step", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: `Delete goal ${GOAL.name}` }));
    expect(api.deleteGoal).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteGoal).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.deleteGoal).mock.calls[0].slice(0, 2)).toEqual([TWIN.user_id, GOAL.id]);
  });

  it("backs out of a delete without writing", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: `Delete goal ${GOAL.name}` }));
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(api.deleteGoal).not.toHaveBeenCalled();
    expect(screen.getByText(GOAL.name)).toBeInTheDocument();
  });

  it("points an empty panel at the chat rather than at a button (PL-12)", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: { ...TWIN, goals: [] }, source: "api" });
    renderPanel();
    expect(
      await screen.findByText("No goals yet. Tell the Assistant about one."),
    ).toBeInTheDocument();
  });
});

describe("Limits section (PL-9)", () => {
  it("saves the emergency reserve and says what it covers", async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByText("Checking plus savings.")).toBeInTheDocument();

    const input = await openField(user, "amount", "Emergency reserve");
    await user.clear(input);
    await user.type(input, "1800{Enter}");

    await waitFor(() => expect(api.setReserve).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.setReserve).mock.calls[0][1]).toEqual({ amount: 1800 });
  });

  it("says when no reserve is declared", async () => {
    const noReserve = {
      ...TWIN,
      constraints: TWIN.constraints.filter((c) => c.type !== "minimum_reserve"),
    };
    vi.mocked(api.getTwin).mockResolvedValue({ data: noReserve, source: "api" });
    renderPanel();
    expect(await screen.findByText("Not set")).toBeInTheDocument();
  });

  it("names the default minimum checking balance until one is set", async () => {
    renderPanel();
    expect(await screen.findByText("$200 (default)")).toBeInTheDocument();
    expect(screen.getByText(/Checking only/)).toBeInTheDocument();
  });

  it("saves a minimum checking balance", async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = await openField(user, "amount", "Minimum checking balance");
    await user.clear(input);
    await user.type(input, "250{Enter}");

    await waitFor(() => expect(api.setMinimumBalance).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.setMinimumBalance).mock.calls[0][1]).toEqual({ amount: 250 });
  });
});

describe("Editing rules (PL-11, G-12, G-16, G-10)", () => {
  it("keeps a bad value on screen with its message and writes nothing", async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = await openField(user, "target amount", GOAL.name);
    await user.clear(input);
    await user.type(input, "0{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter an amount above $0.");
    expect(input).toHaveValue(0);
    expect(api.updateGoal).not.toHaveBeenCalled();
  });

  it("refuses a deadline beyond the two-year horizon (G-11)", async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = await openField(user, "target date", GOAL.name);
    await user.clear(input);
    await user.type(input, "2030-01-01{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("Pick a date on or before");
    expect(api.updateGoal).not.toHaveBeenCalled();
  });

  it("does not save on a keystroke, and Escape discards the edit (G-12, G-17)", async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = await openField(user, "target amount", GOAL.name);
    await user.clear(input);
    await user.type(input, "999");
    expect(api.updateGoal).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(api.updateGoal).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: `Edit target amount for ${GOAL.name}` }))
      .toBeInTheDocument();
  });

  it("closes without a request when the value did not change", async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = await openField(user, "target amount", GOAL.name);
    await user.type(input, "{Enter}");
    expect(api.updateGoal).not.toHaveBeenCalled();
  });

  it("asks the reader to look again when the goal moved underneath them (G-16)", async () => {
    vi.mocked(api.updateGoal).mockRejectedValue(new api.ApiError("Unknown goal", 404));
    const user = userEvent.setup();
    renderPanel();
    const input = await openField(user, "target amount", GOAL.name);
    await user.clear(input);
    await user.type(input, "2500{Enter}");

    await waitFor(() =>
      expect(screen.getByText("That changed. Please review and try again.")).toBeInTheDocument(),
    );
  });

  it("shows the backend's own words for any other rejection (G-9)", async () => {
    vi.mocked(api.updateGoal).mockRejectedValue(new api.ApiError("Deadline is too far out", 422));
    const user = userEvent.setup();
    renderPanel();
    const input = await openField(user, "target amount", GOAL.name);
    await user.clear(input);
    await user.type(input, "2500{Enter}");

    await waitFor(() =>
      expect(screen.getByText("Deadline is too far out")).toBeInTheDocument(),
    );
  });

  it("disables every write offline, with the reason (G-10)", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "fixture" });
    renderPanel();

    const edit = await screen.findByRole("button", {
      name: `Edit target amount for ${GOAL.name}`,
    });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute("title", OFFLINE_REASON);
    expect(screen.getByRole("button", { name: `Delete goal ${GOAL.name}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit amount for Emergency reserve" }))
      .toBeDisabled();
  });
});

describe("Collapsing (section 9.2)", () => {
  it("has a toggle that carries the goal count", async () => {
    renderPanel();
    const toggle = await screen.findByRole("button", { name: /goals & limits \(1\)/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    const user = userEvent.setup();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
