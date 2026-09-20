import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import mockTwin from "@/lib/mock/twin.json";
import type { FinancialTwin, Proposal } from "@/lib/types";
import { ProposalCard } from "./ProposalCard";

const TWIN = mockTwin as unknown as FinancialTwin;

const BILL: Proposal = {
  proposal_id: "prop_tuition",
  status: "pending",
  source_fragment: "i owe tuition, $1,200 due Jan 15",
  requires_user_confirmation: true,
  action_type: "ADD_OBLIGATION",
  obligation: {
    id: "ot_tuition",
    name: "Tuition",
    amount: 1200,
    due_date: "2027-01-15",
    account_id: "acc_checking",
    mandatory: true,
    provenance: "declared",
  },
};

function renderCard(props: Partial<React.ComponentProps<typeof ProposalCard>> = {}) {
  const onDecide = vi.fn();
  const onAskAgain = vi.fn();
  render(
    <ProposalCard
      proposal={BILL}
      twin={TWIN}
      decision={{ status: "pending" }}
      onDecide={onDecide}
      onAskAgain={onAskAgain}
      {...props}
    />,
  );
  return { onDecide, onAskAgain };
}

describe("ProposalCard", () => {
  it("states what would change, in what account, and where it came from", () => {
    renderCard();
    expect(
      screen.getByText(
        "Add bill: Tuition, $1,200 on Jan 15, 2027, paid from Everyday Checking",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Must pay:")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText(/i owe tuition/)).toBeInTheDocument();
  });

  it("hands both decisions back rather than making one", async () => {
    const { onDecide } = renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onDecide.mock.calls).toEqual([["accept"], ["reject"]]);
  });

  it("says the outcome in words, not colour alone (G-18)", () => {
    renderCard({ decision: { status: "accepted" } });
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });

  it("disables both decisions offline and says why (G-10)", () => {
    renderCard({ disabledReason: "Backend offline. Changes are disabled." });
    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();
    expect(accept).toHaveAttribute("title", "Backend offline. Changes are disabled.");
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("offers to ask again when the backend refused the decision", async () => {
    const { onAskAgain } = renderCard({
      decision: { status: "pending", error: "That suggestion has expired." },
    });
    expect(screen.getByText("That suggestion has expired.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Ask again" }));
    expect(onAskAgain).toHaveBeenCalledTimes(1);
  });
});
