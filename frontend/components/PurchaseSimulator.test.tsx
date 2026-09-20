import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import mockTwin from "@/lib/mock/twin.json";
import type { FinancialTwin } from "@/lib/types";
import { PurchaseSimulator } from "./PurchaseSimulator";

const TWIN = mockTwin as unknown as FinancialTwin;
// The mock twin's as_of. The form defaults to it, and nothing earlier is allowed.
const AS_OF = TWIN.as_of;

function renderForm(props: Partial<Parameters<typeof PurchaseSimulator>[0]> = {}) {
  const onSimulate = vi.fn();
  render(
    <PurchaseSimulator
      twin={TWIN}
      isSimulating={false}
      onSimulate={onSimulate}
      {...props}
    />,
  );
  return { onSimulate, user: userEvent.setup() };
}

const submitButton = () => screen.getByRole("button", { name: /Simulate/ });
const amountBox = () => screen.getByLabelText("Amount (USD)");
const dateBox = () => screen.getByLabelText("When");
const whatBox = () => screen.getByLabelText("What");

describe("PurchaseSimulator", () => {
  it("opens on the demo purchase from the spec, ready to submit", () => {
    const { onSimulate } = renderForm();
    expect(whatBox()).toHaveValue("Laptop");
    expect(amountBox()).toHaveValue(800);
    expect(submitButton()).toBeEnabled();
    expect(onSimulate).not.toHaveBeenCalled();
  });

  it("hands up a purchase event the engine will accept", async () => {
    const { onSimulate, user } = renderForm();
    await user.click(submitButton());
    expect(onSimulate).toHaveBeenCalledExactlyOnceWith({
      type: "purchase",
      description: "Laptop",
      amount: 800,
      date: AS_OF,
      account_id: "acc_checking",
    });
  });

  it("spends from checking by default, not whichever account came first", () => {
    renderForm();
    expect(screen.getByLabelText("Paid from")).toHaveValue("acc_checking");
  });

  it("trims the description rather than sending the user's stray spaces", async () => {
    const { onSimulate, user } = renderForm();
    await user.clear(whatBox());
    await user.type(whatBox(), "  Laptop stand  ");
    await user.click(submitButton());
    expect(onSimulate.mock.calls[0][0].description).toBe("Laptop stand");
  });

  it("refuses a description that is only whitespace", async () => {
    const { user } = renderForm();
    await user.clear(whatBox());
    await user.type(whatBox(), "   ");
    expect(submitButton()).toBeDisabled();
  });

  it("refuses an empty amount", async () => {
    const { user } = renderForm();
    await user.clear(amountBox());
    expect(submitButton()).toBeDisabled();
  });

  it("refuses a zero or negative amount", async () => {
    const { user } = renderForm();
    await user.clear(amountBox());
    await user.type(amountBox(), "0");
    expect(submitButton()).toBeDisabled();

    await user.clear(amountBox());
    await user.type(amountBox(), "-800");
    expect(submitButton()).toBeDisabled();
  });

  // Number("1e999") is Infinity, which passes `> 0` but JSON.stringify sends as
  // null, and the engine rejects the whole request.
  it("refuses an amount that overflows to Infinity", async () => {
    const { user } = renderForm();
    await user.clear(amountBox());
    await user.type(amountBox(), "1e999");
    expect(submitButton()).toBeDisabled();
  });

  it("refuses a purchase dated before the twin's as_of", async () => {
    const { user } = renderForm();
    await user.clear(dateBox());
    await user.type(dateBox(), "2020-01-01");
    expect(submitButton()).toBeDisabled();
  });

  it("refuses a purchase past the last day the simulation covers", async () => {
    const { user } = renderForm({ lastDate: "2026-10-01" });
    await user.clear(dateBox());
    await user.type(dateBox(), "2026-12-25");
    expect(submitButton()).toBeDisabled();
  });

  it("accepts a purchase on the last day of the horizon", async () => {
    const { onSimulate, user } = renderForm({ lastDate: "2026-10-01" });
    await user.clear(dateBox());
    await user.type(dateBox(), "2026-10-01");
    await user.click(submitButton());
    expect(onSimulate.mock.calls[0][0].date).toBe("2026-10-01");
  });

  it("bounds the date picker by the horizon it was given", () => {
    renderForm({ lastDate: "2026-10-01" });
    expect(dateBox()).toHaveAttribute("min", AS_OF);
    expect(dateBox()).toHaveAttribute("max", "2026-10-01");
  });

  it("says it is working and takes no second submission", () => {
    const { onSimulate } = renderForm({ isSimulating: true });
    expect(screen.getByRole("button", { name: "Simulating…" })).toBeDisabled();
    expect(onSimulate).not.toHaveBeenCalled();
  });

  it("disables simulation offline and explains why", () => {
    const { onSimulate } = renderForm({ isOffline: true });
    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveAttribute(
      "title",
      "Backend offline. Showing saved sample data. Changes are disabled.",
    );
    expect(onSimulate).not.toHaveBeenCalled();
  });

  // A twin with no accounts has nothing to spend from, and the engine would
  // reject the event with "Unknown account_id ''".
  it("cannot submit against a twin with no accounts", () => {
    renderForm({ twin: { ...TWIN, accounts: [] } });
    expect(submitButton()).toBeDisabled();
  });

  it("falls back to the only account when none is a checking account", () => {
    const savingsOnly = {
      ...TWIN,
      accounts: [{ id: "acc_savings", name: "Savings", type: "savings" as const, balance: 100 }],
    };
    renderForm({ twin: savingsOnly });
    expect(screen.getByLabelText("Paid from")).toHaveValue("acc_savings");
  });

  // Edge case: a horizon that ends before the twin's as_of leaves no valid day at
  // all, so the form must not offer a Simulate the backend would reject.
  it("cannot submit when the horizon ends before the twin's as_of", () => {
    renderForm({ lastDate: "2026-01-01" });
    expect(submitButton()).toBeDisabled();
  });

  // The presenter drives this form with the keyboard. SPEC section 11 asks for a
  // visible focus indicator, and a recoloured 1px border is not one.
  it("keeps a focus ring on every field rather than suppressing the outline", () => {
    renderForm();
    for (const name of ["What", "Amount (USD)", "When", "Paid from"]) {
      const control = screen.getByLabelText(name);
      expect(control).not.toHaveClass("outline-none");
      expect(control).toHaveClass("focus-visible:outline");
      expect(control).toHaveClass("focus-visible:outline-2");
    }
  });

  it("moves focus through the whole form with Tab alone", async () => {
    const { user } = renderForm();
    const order = ["What", "Amount (USD)", "When", "Paid from"].map((n) =>
      screen.getByLabelText(n),
    );
    order[0].focus();
    expect(order[0]).toHaveFocus();
    for (let i = 1; i < order.length; i += 1) {
      await user.tab();
      expect(order[i]).toHaveFocus();
    }
    await user.tab();
    expect(submitButton()).toHaveFocus();
  });
});
