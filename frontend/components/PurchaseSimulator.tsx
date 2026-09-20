"use client";

/**
 * Collects a hypothetical purchase and hands it up as a `SimulationEvent`.
 * Owns form state only; it never calls the API itself.
 */

import { useState } from "react";
import { OFFLINE_REASON } from "@/lib/offline";
import type { FinancialTwin, SimulationEvent } from "@/lib/types";
import { Card } from "./ui";

/** The demo scenario from SPEC.md section 3. */
const DEFAULT_PURCHASE = { description: "Laptop", amount: "800" };

// A 1px border recolour is not a focus indicator on its own: it is the same
// shape as the unfocused state and reads as colour alone. SPEC section 11
// wants focus visible, so the ring is kept alongside the border change.
const field =
  "w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-counter focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter";
const label = "mb-1 block text-xs font-medium uppercase tracking-wider text-muted";

export function PurchaseSimulator({
  twin,
  lastDate,
  isSimulating,
  isOffline = false,
  onSimulate,
}: {
  twin: FinancialTwin;
  /** Last day the simulation covers; later purchases would be rejected. */
  lastDate?: string;
  isSimulating: boolean;
  isOffline?: boolean;
  onSimulate: (event: SimulationEvent) => void;
}) {
  const [description, setDescription] = useState(DEFAULT_PURCHASE.description);
  const [amount, setAmount] = useState(DEFAULT_PURCHASE.amount);
  const [date, setDate] = useState(twin.as_of);
  const [accountId, setAccountId] = useState(
    twin.accounts.find((a) => a.type === "checking")?.id ?? twin.accounts[0]?.id ?? "",
  );

  const parsedAmount = Number(amount);
  // ISO dates compare correctly as strings.
  const inHorizon = date >= twin.as_of && (!lastDate || date <= lastDate);
  const isValid =
    // A twin with no accounts has nothing to spend from, and the engine would
    // reject the event anyway ("Unknown account_id ''").
    twin.accounts.length > 0 &&
    description.trim().length > 0 &&
    // `Number("1e999")` is Infinity, which passes `> 0` and which JSON.stringify
    // sends as `null`. The engine then rejects the whole request.
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0 &&
    date.length === 10 &&
    inHorizon;

  function handleSubmit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    if (!isValid || isOffline) return;
    onSimulate({
      type: "purchase",
      description: description.trim(),
      amount: parsedAmount,
      date,
      account_id: accountId,
    });
  }

  return (
    <Card
      title="What if I buy this?"
      subtitle="Enter a hypothetical purchase and compare the two futures."
    >
      <form onSubmit={handleSubmit} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="purchase-description">
              What
            </label>
            <input
              id="purchase-description"
              className={field}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Laptop"
            />
          </div>
          <div>
            <label className={label} htmlFor="purchase-amount">
              Amount (USD)
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
          <div>
            <label className={label} htmlFor="purchase-date">
              When
            </label>
            <input
              id="purchase-date"
              className={`${field} tnum`}
              type="date"
              min={twin.as_of}
              max={lastDate}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className={label} htmlFor="purchase-account">
              Paid from
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
        </div>

        <button
          type="submit"
          disabled={!isValid || isSimulating || isOffline}
          title={isOffline ? OFFLINE_REASON : undefined}
          className="rounded-lg bg-counter px-4 py-2.5 text-sm font-semibold text-canvas transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSimulating ? "Simulating…" : "Simulate"}
        </button>
      </form>
    </Card>
  );
}
