"use client";

/**
 * One thing the Assistant drafted, waiting for Alex to accept or reject it.
 *
 * The Assistant never changes the twin (AS-1): this card is the only way a
 * draft becomes a fact, and only through its Accept button (AS-15). Props only
 * — it owns no request and decides nothing itself.
 */

import { acceptedLabel, describeProposal } from "@/lib/assistant";
import type { FinancialTwin, Proposal } from "@/lib/types";

/** Where one card has got to. Kept by the chat, which owns the requests. */
export interface ProposalDecision {
  status: "pending" | "accepted" | "rejected";
  isDeciding?: boolean;
  /** A 404 or 409 from the decision route, shown verbatim (G-9, API-3). */
  error?: string;
}

const button =
  "rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter";

export function ProposalCard({
  proposal,
  twin,
  decision,
  disabledReason,
  onDecide,
  onAskAgain,
}: {
  proposal: Proposal;
  twin: FinancialTwin;
  decision: ProposalDecision;
  /** Set when nothing may be written (offline, G-10); also the button tooltip. */
  disabledReason?: string;
  onDecide: (decision: "accept" | "reject") => void;
  onAskAgain: () => void;
}) {
  const { title, fields } = describeProposal(proposal, twin);
  const isDeciding = decision.isDeciding ?? false;
  const isDisabled = isDeciding || disabledReason !== undefined;
  // "Added" / "Updated" / "Dismissed" is the outcome in words, never colour
  // alone (G-18).
  const outcome =
    decision.status === "accepted"
      ? acceptedLabel(proposal)
      : decision.status === "rejected"
        ? "Dismissed"
        : null;

  return (
    <article className="rounded-xl border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>

      {fields.length > 0 ? (
        <dl className="mt-2 grid gap-1 text-sm">
          {fields.map((field) => (
            <div key={field.label} className="flex gap-2">
              <dt className="text-muted">{field.label}:</dt>
              <dd className="text-ink">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {/* The user's own words, quoted back so the reading can be checked against
          what they typed. Never a model's explanation of itself (V1, AS-3). */}
      <p className="mt-2 text-xs text-muted">
        From your message: <q className="italic">{proposal.source_fragment}</q>
      </p>

      {decision.status === "pending" && !decision.error ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onDecide("accept")}
            disabled={isDisabled}
            title={disabledReason}
            className={`${button} bg-counter text-canvas hover:brightness-110`}
          >
            {isDeciding ? "Saving…" : "Accept"}
          </button>
          <button
            type="button"
            onClick={() => onDecide("reject")}
            disabled={isDisabled}
            title={disabledReason}
            className={`${button} border border-line text-ink hover:bg-raised`}
          >
            Reject
          </button>
        </div>
      ) : null}

      {outcome ? <p className="mt-3 text-sm font-semibold text-ink">{outcome}</p> : null}

      {decision.error ? (
        <div className="mt-3">
          <p className="text-sm text-bad">{decision.error}</p>
          <button
            type="button"
            onClick={onAskAgain}
            className={`${button} mt-2 border border-line text-ink hover:bg-raised`}
          >
            Ask again
          </button>
        </div>
      ) : null}
    </article>
  );
}
