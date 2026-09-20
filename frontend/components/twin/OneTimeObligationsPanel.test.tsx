/**
 * The panel has two jobs beyond listing: never present a declared obligation as
 * something TwinBank detected, and say plainly that there are none rather than
 * rendering an empty box a reader cannot interpret.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import mockTwin from "@/lib/mock/twin.json";
import type { FinancialTwin, OneTimeObligation } from "@/lib/types";
import { OneTimeObligationsPanel } from "./OneTimeObligationsPanel";

const TWIN = mockTwin as unknown as FinancialTwin;

function owed(overrides: Partial<OneTimeObligation> = {}): OneTimeObligation {
  return {
    id: "one_car_insurance",
    name: "Car insurance",
    amount: 450,
    due_date: "2026-10-15",
    account_id: "acc_checking",
    mandatory: true,
    provenance: "declared",
    ...overrides,
  };
}

function renderPanel(
  one_time_obligations: OneTimeObligation[] | undefined,
  props: Partial<Parameters<typeof OneTimeObligationsPanel>[0]> = {},
) {
  const onRemove = vi.fn();
  const twin = { ...TWIN, one_time_obligations } as FinancialTwin;
  const view = render(<OneTimeObligationsPanel twin={twin} onRemove={onRemove} {...props} />);
  return { ...view, onRemove, user: userEvent.setup() };
}

describe("listing what is owed", () => {
  it("shows the name, amount, due date and funding account", () => {
    renderPanel([owed()]);
    const row = screen.getByText("Car insurance").closest("li")!;
    expect(within(row).getByText("$450")).toBeInTheDocument();
    expect(within(row).getByText(/October 15, 2026/)).toBeInTheDocument();
    expect(within(row).getByText(/Everyday Checking/)).toBeInTheDocument();
  });

  it("says whether the obligation is mandatory", () => {
    renderPanel([owed()]);
    expect(screen.getByText("Mandatory")).toBeInTheDocument();
  });

  it("says when it is optional instead", () => {
    renderPanel([owed({ mandatory: false })]);
    expect(screen.getByText("Optional")).toBeInTheDocument();
  });

  // SPEC section 2: a one-time obligation is never inferred from transactions.
  it("marks it declared, never observed", () => {
    renderPanel([owed()]);
    expect(screen.getByText("You declared")).toBeInTheDocument();
    expect(screen.queryByText("Observed")).not.toBeInTheDocument();
  });

  // It is a commitment already made, not the purchase being simulated.
  it("says these belong to the baseline future", () => {
    renderPanel([owed()]);
    expect(screen.getByText(/part of your baseline future/)).toBeInTheDocument();
  });

  it("puts the soonest due date first", () => {
    renderPanel([
      owed({ id: "one_tuition", name: "Tuition", due_date: "2027-01-05" }),
      owed({ name: "Car insurance", due_date: "2026-10-15" }),
    ]);
    const names = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(names[0]).toContain("Car insurance");
    expect(names[1]).toContain("Tuition");
  });

  it("falls back to the account id when the twin no longer holds that account", () => {
    renderPanel([owed({ account_id: "acc_closed" })]);
    expect(screen.getByText(/acc_closed/)).toBeInTheDocument();
  });
});

describe("the empty state", () => {
  it("says none are declared rather than showing an empty panel", () => {
    renderPanel([]);
    expect(screen.getByText(/None declared/)).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  // The short sentence makes the compiler ask for the account and the mandatory
  // flag rather than guessing them, so the copy must not promise one step.
  it("says how to declare one, and that TwinBank may ask for more", () => {
    renderPanel([]);
    expect(screen.getByText(/asks for whatever it needs before you confirm the draft/))
      .toBeInTheDocument();
  });

  // An older backend omits the field entirely. That is "none", not a failure.
  it("reads a twin without the field as none, not as an error", () => {
    renderPanel(undefined);
    expect(screen.getByText(/None declared/)).toBeInTheDocument();
  });
});

describe("removing one", () => {
  it("asks once more before removing, since it cannot be undone from here", async () => {
    const { onRemove, user } = renderPanel([owed()]);
    await user.click(screen.getByRole("button", { name: "Remove Car insurance" }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("Remove this obligation?")).toBeInTheDocument();
  });

  it("removes it by id once confirmed", async () => {
    const { onRemove, user } = renderPanel([owed()]);
    await user.click(screen.getByRole("button", { name: "Remove Car insurance" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledWith("one_car_insurance");
  });

  it("backs out without removing anything", async () => {
    const { onRemove, user } = renderPanel([owed()]);
    await user.click(screen.getByRole("button", { name: "Remove Car insurance" }));
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove Car insurance" })).toBeInTheDocument();
  });

  // Several obligations can be on screen at once: only the one being removed
  // may say so, which is what the scope is for.
  it("says Removing… only on the row whose save is running", async () => {
    const both = [owed(), owed({ id: "one_tuition", name: "Tuition" })];
    const { rerender, user } = renderPanel(both);
    await user.click(screen.getByRole("button", { name: "Remove Car insurance" }));
    await user.click(screen.getByRole("button", { name: "Remove Tuition" }));

    rerender(
      <OneTimeObligationsPanel
        twin={{ ...TWIN, one_time_obligations: both } as FinancialTwin}
        isBusy
        savingScope="one_car_insurance"
        onRemove={vi.fn()}
      />,
    );

    const insurance = screen.getByText("Car insurance").closest("li")!;
    const tuition = screen.getByText("Tuition").closest("li")!;
    expect(within(insurance).getByText("Removing…")).toBeInTheDocument();
    expect(within(tuition).getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("blocks removal while another twin update is in flight", () => {
    renderPanel([owed()], { isBusy: true, savingScope: "declared-goals" });
    expect(screen.getByRole("button", { name: "Remove Car insurance" })).toBeDisabled();
  });

  it("offers no removal at all when the page passes no handler", () => {
    render(
      <OneTimeObligationsPanel twin={{ ...TWIN, one_time_obligations: [owed()] } as FinancialTwin} />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
