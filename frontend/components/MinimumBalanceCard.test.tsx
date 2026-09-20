import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MINIMUM_BALANCE_SCOPE } from "@/lib/scopes";
import { DEFAULT_LOW_BALANCE_THRESHOLD, type FinancialConstraint } from "@/lib/types";
import { MinimumBalanceCard } from "./MinimumBalanceCard";

const MINIMUM: FinancialConstraint = {
  id: "con_minimum_checking",
  type: "minimum_checking_balance",
  amount: 300,
  description: "Keep at least $300 in checking.",
  provenance: "declared",
};

function renderCard(props: Partial<Parameters<typeof MinimumBalanceCard>[0]> = {}) {
  const onSave = vi.fn();
  render(<MinimumBalanceCard isBusy={false} onSave={onSave} {...props} />);
  return { onSave, user: userEvent.setup() };
}

const box = () => screen.getByLabelText("Minimum checking balance in dollars");

describe("MinimumBalanceCard", () => {
  it("names the simulator's default rather than implying a figure of Alex's own", () => {
    renderCard();
    expect(
      screen.getByText(`Not set. The simulation assumes $${DEFAULT_LOW_BALANCE_THRESHOLD}.`),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set" })).toBeInTheDocument();
  });

  it("shows a declared minimum as declared, not observed", () => {
    renderCard({ minimum: MINIMUM });
    expect(screen.getByText("$300")).toBeInTheDocument();
    expect(screen.getByText("You declared")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  it("starts the box at the saved minimum so Update edits it rather than retypes it", () => {
    renderCard({ minimum: MINIMUM });
    expect(box()).toHaveValue(300);
  });

  it("hands up the number, not the string the user typed", async () => {
    const { onSave, user } = renderCard();
    await user.type(box(), "250");
    await user.click(screen.getByRole("button", { name: "Set" }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(250);
  });

  it("cannot be submitted empty", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "Set" })).toBeDisabled();
  });

  it("refuses a negative minimum", async () => {
    const { user } = renderCard();
    await user.type(box(), "-100");
    expect(screen.getByRole("button", { name: "Set" })).toBeDisabled();
  });

  it("accepts zero, which is a real answer and not the same as unset", async () => {
    const { onSave, user } = renderCard();
    await user.type(box(), "0");
    await user.click(screen.getByRole("button", { name: "Set" }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("refuses an amount that overflows to Infinity", async () => {
    const { user } = renderCard();
    await user.type(box(), "1e999");
    expect(screen.getByRole("button", { name: "Set" })).toBeDisabled();
  });

  it("submits on Enter, as a one-field form should", async () => {
    const { onSave, user } = renderCard();
    await user.type(box(), "450{Enter}");
    expect(onSave).toHaveBeenCalledExactlyOnceWith(450);
  });

  it("blocks a save while another twin update is in flight", async () => {
    const { user } = renderCard({ isBusy: true });
    await user.type(box(), "250");
    expect(screen.getByRole("button", { name: "Set" })).toBeDisabled();
  });

  it("says Saving… only when this control is the one saving", () => {
    const { rerender } = render(
      <MinimumBalanceCard isBusy savingScope="goal_summer_housing" onSave={vi.fn()} />,
    );
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();

    rerender(
      <MinimumBalanceCard isBusy savingScope={MINIMUM_BALANCE_SCOPE} onSave={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument();
  });

  // SPEC section 11: focus stays visible. A recoloured border is not a ring.
  it("keeps a focus ring on the amount box", () => {
    render(<MinimumBalanceCard isBusy={false} onSave={vi.fn()} />);
    expect(box()).not.toHaveClass("outline-none");
    expect(box()).toHaveClass("focus-visible:outline");
  });
});
