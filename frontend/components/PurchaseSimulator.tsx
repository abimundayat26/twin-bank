"use client";

/**
 * The purchase form at the top of the Simulator (SM-1 to SM-3).
 *
 * It owns form state and validity only; it never calls the API. Every rule it
 * enforces is enforced again by the backend — the inline message is there so
 * the reader is told before they wait for a 422, not instead of it (G-11).
 *
 * The backend's own rejection is shown here too (SM-3, API-3), because the
 * field that has to change is in this card.
 */

import { useState } from "react";
import { addDays } from "@/lib/dates";
import { money } from "@/lib/format";
import { OFFLINE_REASON } from "@/lib/offline";
import type { FinancialTwin, SimulationEvent } from "@/lib/types";
import { Card } from "./ui";

/** The demo scenario (section 18). */
const DEFAULT_PURCHASE = { description: "Laptop", amount: "800" };

/** G-11: a purchase may be dated today, but no further out than two years. */
const MAX_HORIZON_DAYS = 730;

/** E-18 and E-3: the bounds the backend also holds. */
const MAX_NAME = 80;
const MAX_AMOUNT = 1_000_000_000;

/**
 * A purchase the Assistant read out of a what-if, handed over filled in but not
 * run (PL-6, AS-8). Every field is optional: whatever is missing keeps the
 * default, and nothing here is submitted until the user presses Simulate.
 */
export interface PurchasePrefill {
  description?: string;
  amount?: string;
  date?: string;
}

// A 1px border recolour is not a focus indicator on its own: it is the same
// shape as the unfocused state and reads as colour alone. SPEC section 11
// wants focus visible, so the ring is kept alongside the border change.
const field =
  "w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-counter focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter";
const label = "mb-1 block text-xs font-medium uppercase tracking-wider text-muted";

/**
 * The first thing wrong with the form, or null. One message at a time: the
 * reader fixes one field, and a wall of red says less than a sentence does.
 */
export function formProblem(
  twin: FinancialTwin,
  description: string,
  amount: string,
  date: string,
  lastDate?: string,
): string | null {
  if (twin.accounts.length === 0) return "This twin has no account to spend from.";

  const name = description.trim();
  if (name.length === 0) return "Say what the purchase is.";
  if (name.length > MAX_NAME) return `Keep the name to ${MAX_NAME} characters or fewer.`;

  // Number("1e999") is Infinity, which passes `> 0` and which JSON.stringify
  // sends as null; Number("") is 0. Both have to fail here.
  const parsed = Number(amount);
  if (amount.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
    return "Enter an amount above $0.";
  }
  if (parsed > MAX_AMOUNT) return `Enter an amount under ${money(MAX_AMOUNT)}.`;

  if (date.length !== 10) return "Pick a date for the purchase.";
  if (date < twin.as_of) return "A purchase cannot be dated before today.";
  if (date > addDays(twin.as_of, MAX_HORIZON_DAYS)) {
    return "TwinBank only projects two years ahead.";
  }
  // E-2: the engine rejects an event after the horizon it is simulating.
  if (lastDate && date > lastDate) return "That is after the period this simulation covers.";

  return null;
}

export function PurchaseSimulator({
  twin,
  lastDate,
  isSimulating,
  prefill,
  isOffline = false,
  error,
  onSimulate,
}: {
  twin: FinancialTwin;
  /** Last day the simulation covers; later purchases would be rejected. */
  lastDate?: string;
  isSimulating: boolean;
  /** Starting values from a what-if the Assistant routed here (PL-6). */
  prefill?: PurchasePrefill;
  /** G-10: offline, nothing may pretend to run. */
  isOffline?: boolean;
  /** The backend's `detail`, verbatim (G-9). */
  error?: string;
  onSimulate: (event: SimulationEvent) => void;
}) {
  const [description, setDescription] = useState(
    prefill?.description ?? DEFAULT_PURCHASE.description,
  );
  const [amount, setAmount] = useState(prefill?.amount ?? DEFAULT_PURCHASE.amount);
  // G-11: the day after as_of, so the default is a purchase that can also be
  // committed (a purchase dated as_of simulates but cannot, E-1).
  const [date, setDate] = useState(prefill?.date ?? addDays(twin.as_of, 1));
  const [accountId, setAccountId] = useState(
    twin.accounts.find((a) => a.type === "checking")?.id ?? twin.accounts[0]?.id ?? "",
  );

  // Shown as soon as it is true, never held back until a submit: the button
  // that would submit is disabled while the form is invalid (SM-2), so this
  // message is the only thing telling the reader why.
  const problem = formProblem(twin, description, amount, date, lastDate);
  const disabled = problem != null || isSimulating || isOffline;

  function handleSubmit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    if (disabled) return;
    onSimulate({
      type: "purchase",
      description: description.trim(),
      amount: Number(amount),
      date,
      account_id: accountId,
    });
  }

  return (
    <Card
      title="What if I buy this?"
      subtitle="One purchase at a time. Nothing here moves money."
    >
      <form onSubmit={handleSubmit} noValidate className="grid gap-4">
        {/* SM-1: one row that wraps, rather than a column that pushes the
            comparison off the first screen. */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[10rem] flex-[2_1_12rem]">
            <label className={label} htmlFor="purchase-description">
              What
            </label>
            <input
              id="purchase-description"
              className={field}
              value={description}
              maxLength={MAX_NAME}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Laptop"
            />
          </div>
          <div className="min-w-[7rem] flex-[1_1_7rem]">
            <label className={label} htmlFor="purchase-amount">
              Amount
            </label>
            <input
              id="purchase-amount"
              className={`${field} tnum`}
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="min-w-[9rem] flex-[1_1_9rem]">
            <label className={label} htmlFor="purchase-date">
              Date
            </label>
            <input
              id="purchase-date"
              className={`${field} tnum`}
              type="date"
              min={twin.as_of}
              max={lastDate ?? addDays(twin.as_of, MAX_HORIZON_DAYS)}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="min-w-[9rem] flex-[1_1_9rem]">
            <label className={label} htmlFor="purchase-account">
              Pay from
            </label>
            <select
              id="purchase-account"
              className={field}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {twin.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={disabled}
            title={isOffline ? OFFLINE_REASON : undefined}
            className="rounded-lg bg-counter px-4 py-2.5 text-sm font-semibold text-canvas transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSimulating ? "Simulating…" : "Simulate"}
          </button>
        </div>

        {problem ? (
          <p role="alert" className="text-sm text-bad">
            {problem}
          </p>
        ) : null}
        {/* SM-3: the backend's own words, in the card that made the request. */}
        {error ? (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        ) : null}
      </form>
    </Card>
  );
}
