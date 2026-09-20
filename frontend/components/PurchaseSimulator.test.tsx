import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { addDays } from "@/lib/dates";
import mockTwin from "@/lib/mock/twin.json";
import type { FinancialTwin } from "@/lib/types";
import { PurchaseSimulator } from "./PurchaseSimulator";

const TWIN = mockTwin as unknown as FinancialTwin;
const AS_OF = TWIN.as_of;
/** G-11: the form's default date, and the earliest one that can be committed. */
const TOMORROW = addDays(AS_OF, 1);

function renderForm(props: Partial<Parameters<typeof PurchaseSimulator>[0]> = {}) {
  const onSimulate = vi.fn();
  render(
    <PurchaseSimulator twin={TWIN} isSimulating={false} onSimulate={onSimulate} {...props} />,
  );
  return { onSimulate, user: userEvent.setup() };
}

const submitButton = () => screen.getByRole("button", { name: /Simulate/ });
const amountBox = () => screen.getByLabelText("Amount");
const dateBox = () => screen.getByLabelText("Date");
const whatBox = () => screen.getByLabelText("What");

/** The inline message explaining why Simulate is disabled. */
const problem = () => screen.getByRole("alert").textContent ?? "";

describe("PurchaseSimulator", () => {
  // SM-1
  it("opens on the demo purchase, dated the day after as_of", () => {
    const { onSimulate } = renderForm();
    expect(whatBox()).toHaveValue("Laptop");
    expect(amountBox()).toHaveValue(800);
    expect(dateBox()).toHaveValue(TOMORROW);
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
      date: TOMORROW,
      account_id: "acc_checking",
    });
  });

  it("spends from checking by default, not whichever account came first", () => {
    renderForm();
    expect(screen.getByLabelText("Pay from")).toHaveValue("acc_checking");
  });

  it("trims the description rather than sending stray spaces", async () => {
    const { onSimulate, user } = renderForm();
    await user.clear(whatBox());
    await user.type(whatBox(), "  Laptop stand  ");
    await user.click(submitButton());
    expect(onSimulate.mock.calls[0][0].description).toBe("Laptop stand");
  });

  // PL-6: the Assistant fills the form and leaves the decision to press to the reader.
  it("takes a prefilled purchase without submitting it", () => {
    const { onSimulate } = renderForm({
      prefill: { description: "Bike", amount: "450", date: addDays(AS_OF, 10) },
    });
    expect(whatBox()).toHaveValue("Bike");
    expect(amountBox()).toHaveValue(450);
    expect(dateBox()).toHaveValue(addDays(AS_OF, 10));
    expect(onSimulate).not.toHaveBeenCalled();
  });

  // E-3
  it.each([
    ["an empty amount", ""],
    ["zero", "0"],
    ["a negative amount", "-5"],
    // Number("1e999") is Infinity, which JSON.stringify would send as null.
    ["an amount that overflows to Infinity", "1e999"],
    ["an amount over a billion dollars", "1000000001"],
  ])("refuses %s", async (_label, value) => {
    const { onSimulate, user } = renderForm();
    await user.clear(amountBox());
    if (value) await user.type(amountBox(), value);
    expect(submitButton()).toBeDisabled();
    await user.click(submitButton());
    expect(onSimulate).not.toHaveBeenCalled();
  });

  // E-18
  it("refuses a whitespace-only name and one over 80 characters", async () => {
    const { onSimulate, user } = renderForm();
    await user.clear(whatBox());
    await user.type(whatBox(), "   ");
    expect(problem()).toBe("Say what the purchase is.");
    expect(onSimulate).not.toHaveBeenCalled();
    // The field also stops at 80, so the over-length case cannot be typed in.
    expect(whatBox()).toHaveAttribute("maxLength", "80");
  });

  // G-11
  it("refuses a purchase dated before as_of, and one over two years out", async () => {
    const { user } = renderForm();
    await user.clear(dateBox());
    await user.type(dateBox(), addDays(AS_OF, -1));
    expect(problem()).toBe("A purchase cannot be dated before today.");

    await user.clear(dateBox());
    await user.type(dateBox(), addDays(AS_OF, 731));
    expect(problem()).toBe("TwinBank only projects two years ahead.");
  });

  // E-1: it can be simulated, so the form allows it; only committing refuses.
  it("allows a purchase dated exactly as_of", async () => {
    const { onSimulate, user } = renderForm();
    await user.clear(dateBox());
    await user.type(dateBox(), AS_OF);
    await user.click(submitButton());
    expect(onSimulate.mock.calls[0][0].date).toBe(AS_OF);
  });

  // E-2
  it("refuses a purchase past the last day the simulation covers", async () => {
    const { user } = renderForm({ lastDate: "2027-05-01" });
    await user.clear(dateBox());
    await user.type(dateBox(), "2027-05-02");
    expect(problem()).toBe(
      "That is after the period this simulation covers.",
    );
  });

  it("accepts a purchase on the last day of the horizon", async () => {
    const { onSimulate, user } = renderForm({ lastDate: "2027-05-01" });
    await user.clear(dateBox());
    await user.type(dateBox(), "2027-05-01");
    await user.click(submitButton());
    expect(onSimulate.mock.calls[0][0].date).toBe("2027-05-01");
  });

  it("bounds the date picker by the horizon it was given", () => {
    renderForm({ lastDate: "2027-05-01" });
    expect(dateBox()).toHaveAttribute("min", AS_OF);
    expect(dateBox()).toHaveAttribute("max", "2027-05-01");
  });

  it("bounds it two years out when the simulation has no horizon yet", () => {
    renderForm();
    expect(dateBox()).toHaveAttribute("max", addDays(AS_OF, 730));
  });

  // SM-2
  it("cannot be submitted twice while a run is in flight", () => {
    renderForm({ isSimulating: true });
    const inFlight = screen.getByRole("button", { name: /Simulat/ });
    expect(inFlight).toBeDisabled();
    expect(inFlight).toHaveTextContent("Simulating…");
  });

  // G-10: nothing may pretend to run against a backend that is not there.
  it("is disabled offline, with the reason in its tooltip", () => {
    renderForm({ isOffline: true });
    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveAttribute(
      "title",
      "Backend offline. Showing saved sample data. Changes are disabled.",
    );
  });

  // SM-3 / API-3 / G-9
  it("shows the backend's rejection in the form, in its own words", () => {
    renderForm({ error: "Unknown account_id 'acc_nope'" });
    expect(screen.getByRole("alert")).toHaveTextContent("Unknown account_id 'acc_nope'");
  });

  it("falls back to the only account when none is a checking account", () => {
    const savings = TWIN.accounts.filter((a) => a.type !== "checking");
    renderForm({ twin: { ...TWIN, accounts: savings } });
    expect(screen.getByLabelText("Pay from")).toHaveValue(savings[0].id);
  });

  it("says so rather than offering a simulation a twin with no account cannot run", () => {
    renderForm({ twin: { ...TWIN, accounts: [] } });
    expect(problem()).toBe("This twin has no account to spend from.");
  });

  // G-17
  it("keeps a focus ring on every field rather than suppressing the outline", () => {
    renderForm();
    for (const element of [whatBox(), amountBox(), dateBox(), screen.getByLabelText("Pay from")]) {
      expect(element.className).toContain("focus-visible:outline");
    }
  });

  it("moves focus through the whole form with Tab alone", async () => {
    const { user } = renderForm();
    whatBox().focus();
    for (const next of [amountBox(), dateBox(), screen.getByLabelText("Pay from"), submitButton()]) {
      await user.tab();
      expect(next).toHaveFocus();
    }
  });
});
