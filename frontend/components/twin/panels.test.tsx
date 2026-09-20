/**
 * The read-only twin panels, together: each is a thin rendering of one slice of
 * the contract, so they share a fixture rather than a file apiece.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import mockTwin from "@/lib/mock/twin.json";
import type { FinancialTwin } from "@/lib/types";
import { AccountsPanel } from "./AccountsPanel";
import { IncomePanel } from "./IncomePanel";
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
    expect(screen.getByText("As of September 18, 2026")).toBeInTheDocument();
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
