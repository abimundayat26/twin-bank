/**
 * The read-only twin panels, together: each is a thin rendering of one slice of
 * the contract, so they share a fixture rather than a file apiece.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import mockTwin from "@/lib/mock/twin.json";
import type { FinancialTwin } from "@/lib/types";
import { AccountsPanel } from "./AccountsPanel";
import { ConstraintsPanel } from "./ConstraintsPanel";
import { IncomePanel } from "./IncomePanel";
import { ObligationsPanel } from "./ObligationsPanel";
import { SpendingPanel } from "./SpendingPanel";

const TWIN = mockTwin as unknown as FinancialTwin;
const twinWith = (overrides: Partial<FinancialTwin>): FinancialTwin => ({
  ...TWIN,
  ...overrides,
});

describe("AccountsPanel", () => {
  it("shows the server-computed total to the cent, not a re-added one", () => {
    render(<AccountsPanel twin={twinWith({ total_balance: 4321.09 })} />);
    expect(screen.getByText("$4,321.09")).toBeInTheDocument();
  });

  it("lists each account with its kind", () => {
    render(<AccountsPanel twin={TWIN} />);
    expect(screen.getByText("Everyday Checking")).toBeInTheDocument();
    expect(screen.getByText("Checking")).toBeInTheDocument();
    // The savings account is named "Savings" and typed "Savings": name and hint.
    expect(screen.getAllByText("Savings")).toHaveLength(2);
  });

  it("dates the balance so it is never read as live", () => {
    render(<AccountsPanel twin={TWIN} />);
    expect(screen.getByText("As of September 19, 2026")).toBeInTheDocument();
  });

  // SPEC 3.1: the total is not spendable money.
  it("says the total is not all free to spend", () => {
    render(<AccountsPanel twin={TWIN} />);
    expect(screen.getByText(/Not all of this is free to spend/)).toBeInTheDocument();
  });

  it("renders a twin with no accounts rather than failing", () => {
    render(<AccountsPanel twin={twinWith({ accounts: [], total_balance: 0 })} />);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });
});

describe("IncomePanel", () => {
  it("states cadence and uncertainty, not just the amount", () => {
    render(
      <IncomePanel
        twin={twinWith({
          income: [
            {
              id: "inc_job",
              source: "Part-time job",
              expected_amount: 720,
              interval_days: 14,
              next_date: "2026-09-25",
              uncertainty: 45,
              provenance: "observed",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("$720")).toBeInTheDocument();
    expect(
      screen.getByText("Every 14 days · next September 25, 2026 · ±$45"),
    ).toBeInTheDocument();
    expect(screen.getByText("Observed")).toBeInTheDocument();
  });

  it("renders a twin with no income stream", () => {
    render(<IncomePanel twin={twinWith({ income: [] })} />);
    expect(screen.getByRole("heading", { name: "Expected income" })).toBeInTheDocument();
  });
});

describe("SpendingPanel", () => {
  it("shows each category's fortnightly mean and spread", () => {
    render(<SpendingPanel twin={TWIN} />);
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getAllByText(/std dev per 14 days/).length).toBeGreaterThan(0);
  });

  it("falls back to a plain subtitle when no forecast metadata came back", () => {
    render(<SpendingPanel twin={twinWith({ forecast: null })} />);
    expect(screen.getByText("Observed 14-day averages")).toBeInTheDocument();
  });

  it("describes how the figures were fitted when the backend said", () => {
    render(
      <SpendingPanel
        twin={twinWith({
          forecast: {
            method: "seasonal_ewma",
            as_of: "2026-09-19",
            window_start: "2026-03-19",
            observed_fortnights: 13,
            half_life_days: 60,
          },
        })}
      />,
    );
    expect(screen.getByText(/Fitted to 13 fortnights of spending/)).toBeInTheDocument();
    expect(screen.getByText(/60-day half-life/)).toBeInTheDocument();
  });

  it("adds no seasonal sparkline to a category with a flat profile", () => {
    render(
      <SpendingPanel
        twin={twinWith({
          variable_spending: [
            {
              category: "groceries",
              mean_14d: 180,
              std_dev_14d: 40,
              provenance: "observed",
              seasonal: { factors: { "1": 1, "2": 1 } },
            },
          ],
        })}
      />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  // The label is built with `category[0].toUpperCase()`, which throws on "".
  it("survives a category with an empty name", () => {
    render(
      <SpendingPanel
        twin={twinWith({
          variable_spending: [
            { category: "", mean_14d: 100, std_dev_14d: 10, provenance: "observed" },
          ],
        })}
      />,
    );
    expect(screen.getByText("$100 / 14d")).toBeInTheDocument();
  });
});

describe("ObligationsPanel", () => {
  const onAnswer = vi.fn();

  it("separates mandatory bills from merely recurring ones", () => {
    render(<ObligationsPanel twin={TWIN} onAnswer={onAnswer} />);
    const mandatory = screen.getByRole("heading", { name: "Upcoming obligations" })
      .closest("section")!;
    expect(within(mandatory).getByText("Rent")).toBeInTheDocument();

    const recurring = screen.getByRole("heading", { name: "Recurring expenses" })
      .closest("section")!;
    expect(within(recurring).getByText("Streaming subscriptions")).toBeInTheDocument();
  });

  it("asks its open question inline, next to the obligation it is about", () => {
    render(<ObligationsPanel twin={TWIN} onAnswer={onAnswer} />);
    expect(screen.getByText("What is this?")).toBeInTheDocument();
  });

  it("reports an answer with the obligation it belongs to", async () => {
    const answer = vi.fn();
    const user = userEvent.setup();
    render(<ObligationsPanel twin={TWIN} onAnswer={answer} />);
    await user.click(screen.getByRole("button", { name: /Savings transfer/ }));
    expect(answer).toHaveBeenCalledWith("obl_mystery_transfer", "savings_transfer");
  });

  it("hides the excluded section until something is declared not recurring", () => {
    render(<ObligationsPanel twin={TWIN} onAnswer={onAnswer} />);
    expect(screen.queryByText("Left out of the projection")).not.toBeInTheDocument();
  });

  it("shows what Alex declared out of the projection", () => {
    const excluded = TWIN.obligations.map((o) =>
      o.id === "obl_subscriptions"
        ? { ...o, declared_category: "not_recurring" as const, category_candidates: [] }
        : o,
    );
    render(<ObligationsPanel twin={twinWith({ obligations: excluded })} onAnswer={onAnswer} />);
    const section = screen.getByRole("heading", { name: "Left out of the projection" })
      .closest("section")!;
    expect(within(section).getByText("Streaming subscriptions")).toBeInTheDocument();
  });

  // A declared category overrides the bank's observed mandatory flag.
  it("moves an obligation Alex called optional out of the mandatory list", () => {
    const declared = TWIN.obligations.map((o) =>
      o.id === "obl_phone"
        ? { ...o, declared_category: "optional_spending" as const, category_candidates: [] }
        : o,
    );
    render(<ObligationsPanel twin={twinWith({ obligations: declared })} onAnswer={onAnswer} />);
    const mandatory = screen.getByRole("heading", { name: "Upcoming obligations" })
      .closest("section")!;
    expect(within(mandatory).queryByText("Phone plan")).not.toBeInTheDocument();

    const recurring = screen.getByRole("heading", { name: "Recurring expenses" })
      .closest("section")!;
    expect(within(recurring).getByText("Phone plan")).toBeInTheDocument();
  });

  it("renders both sections for a twin with no obligations at all", () => {
    render(<ObligationsPanel twin={twinWith({ obligations: [] })} onAnswer={onAnswer} />);
    expect(screen.getByRole("heading", { name: "Upcoming obligations" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recurring expenses" })).toBeInTheDocument();
  });
});

describe("ConstraintsPanel", () => {
  it("shows the emergency reserve in the words Alex declared it in", () => {
    render(<ConstraintsPanel twin={TWIN} onSetMinimum={vi.fn()} />);
    expect(screen.getByText("$1,500")).toBeInTheDocument();
    expect(screen.getByText(TWIN.constraints[0].description)).toBeInTheDocument();
  });

  it("omits the reserve card when none is declared", () => {
    render(<ConstraintsPanel twin={twinWith({ constraints: [] })} onSetMinimum={vi.fn()} />);
    expect(
      screen.queryByRole("heading", { name: "Minimum emergency reserve" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Minimum checking balance" }),
    ).toBeInTheDocument();
  });

  it("passes a saved minimum through to the card", () => {
    render(
      <ConstraintsPanel
        twin={twinWith({
          constraints: [
            ...TWIN.constraints,
            {
              id: "con_minimum_checking",
              type: "minimum_checking_balance",
              amount: 300,
              description: "Keep at least $300 in checking.",
              provenance: "declared",
            },
          ],
        })}
        onSetMinimum={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Minimum checking balance in dollars")).toHaveValue(300);
  });

  // The card is keyed by the saved amount so a successful save refills the box
  // from the twin rather than leaving the old draft in place.
  it("refills the box after the saved minimum changes", () => {
    const withMinimum = (amount: number) =>
      twinWith({
        constraints: [
          {
            id: "con_minimum_checking",
            type: "minimum_checking_balance",
            amount,
            description: `Keep at least $${amount} in checking.`,
            provenance: "declared",
          },
        ],
      });
    const { rerender } = render(
      <ConstraintsPanel twin={withMinimum(300)} onSetMinimum={vi.fn()} />,
    );
    rerender(<ConstraintsPanel twin={withMinimum(450)} onSetMinimum={vi.fn()} />);
    expect(screen.getByLabelText("Minimum checking balance in dollars")).toHaveValue(450);
  });
});
