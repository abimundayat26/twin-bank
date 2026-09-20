"use client";

/**
 * The TwinBank Assistant: a chat that drafts, asks, and never writes.
 *
 * Everything it says is a template the backend chose (AS-3); every reading is
 * labelled with who did it (AS-4); and nothing reaches the Financial Twin until
 * Alex presses Accept on a card (AS-1, AS-15). The transcript lives here, in
 * memory, for the session only: a reload starts a fresh conversation and the
 * twin keeps whatever was accepted (PL-8).
 *
 * SPEC section 9.2, PL-1 to PL-8.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  decideProposal,
  getAssistantOpening,
  getTwin,
  respondToClarification,
  sendAssistantMessage,
} from "@/lib/api";
import { categoryForLabel, obligationForQuestion, simulateHref } from "@/lib/assistant";
import { OFFLINE_REASON } from "@/lib/offline";
import { useTwin } from "@/lib/state/TwinProvider";
import type {
  AssistantMessageResponse,
  AssistantQuestion,
  FinancialTwin,
  Proposal,
  SimulatePrefill,
} from "@/lib/types";
import { Card } from "../ui";
import { ProposalCard, type ProposalDecision } from "./ProposalCard";

/** AS-10. The backend rejects anything longer; the composer refuses to send it. */
const MAX_CHARACTERS = 2000;
/** AS-13. Far enough from the limit to be a warning rather than an alarm. */
const COUNTER_FROM = 1800;

const OPENING_PROMPT = "Tell me a goal, a limit, a bill, or a what-if.";
/**
 * G-14: a fixture may stand in for a twin, never for an assistant reply. With no
 * backend there is nothing honest to put in the transcript, so the chat says so.
 */
const UNREACHABLE = "Could not reach the backend, so nothing was read. Try again.";

type Entry =
  | { kind: "user"; key: string; text: string }
  | {
      kind: "assistant";
      key: string;
      /** What an answer to this message's question quotes (AS-11). Null for the opening. */
      messageId: string | null;
      reply: string;
      /** Who read the user's words. Null when nothing was read (the opening questions). */
      readBy: "rules" | "model" | null;
      proposals: Proposal[];
      questions: AssistantQuestion[];
      prefill: SimulatePrefill | null;
    }
  | { kind: "error"; key: string; text: string };

/** A new entry, before the transcript gives it its key. Distributes over the union. */
type Unkeyed<T> = T extends unknown ? Omit<T, "key"> : never;

/** Which question the composer is answering, and what it says it is answering. */
interface Answering {
  messageId: string;
  question: string;
}

const button =
  "rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter";
const quickReply = `${button} border border-counter text-counter hover:bg-counter/10`;

/** A backend that answered with an error is quoted verbatim (G-9). */
function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : UNREACHABLE;
}

export function AssistantChat() {
  const { twin, isOffline, applyTwin } = useTwin();

  const [entries, setEntries] = useState<Entry[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [answering, setAnswering] = useState<Answering | null>(null);
  const [text, setText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, ProposalDecision>>({});
  /** Opening questions already answered, by `question_id`: "busy" or the answer. */
  const [answered, setAnswered] = useState<Record<string, string>>({});

  const nextKey = useRef(0);
  const askedForOpening = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);

  // AppShell already carries the banner (G-10); here it is the reason every
  // control gives for being unavailable.
  const disabledReason = isOffline ? OFFLINE_REASON : undefined;

  function add(entry: Unkeyed<Entry>) {
    nextKey.current += 1;
    setEntries((current) => [...current, { ...entry, key: `e${nextKey.current}` } as Entry]);
  }

  // PL-1. Asked once per mount, and only when the twin came from the backend:
  // offline there is no honest answer to show.
  useEffect(() => {
    if (!twin || isOffline || askedForOpening.current) return;
    askedForOpening.current = true;
    let cancelled = false;
    getAssistantOpening(twin.user_id)
      .then((opening) => {
        if (cancelled) return;
        // One bubble per question: each is answered on its own (AS-9).
        for (const question of opening.questions ?? []) {
          add({
            kind: "assistant",
            messageId: null,
            reply: "",
            readBy: null,
            proposals: [],
            questions: [question],
            prefill: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) add({ kind: "error", text: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [twin, isOffline]);

  async function send(message: string, inReplyTo: string | null) {
    const trimmed = message.trim();
    if (!twin || isSending || isOffline || !trimmed || trimmed.length > MAX_CHARACTERS) return;

    add({ kind: "user", text: trimmed });
    setText("");
    setAnswering(null);
    setIsSending(true);
    try {
      const response: AssistantMessageResponse = await sendAssistantMessage({
        user_id: twin.user_id,
        text: trimmed,
        conversation_id: conversationId,
        in_reply_to: inReplyTo,
      });
      setConversationId(response.conversation_id);
      const questions = response.questions ?? [];
      add({
        kind: "assistant",
        messageId: response.message_id,
        reply: response.reply,
        readBy: response.read_by,
        proposals: response.proposals ?? [],
        questions,
        prefill: response.simulate_prefill ?? null,
      });
      // PL-7: a question with choices is answered by pressing one. One without
      // needs the composer, which then says what it is answering.
      const open = questions.find((question) => (question.choices?.length ?? 0) === 0);
      if (open) setAnswering({ messageId: response.message_id, question: open.text });
    } catch (error: unknown) {
      add({ kind: "error", text: errorText(error) });
      // An expired question cannot be answered again (AS-11): back to a new message.
      if (error instanceof ApiError && error.status === 422) setAnswering(null);
    } finally {
      setIsSending(false);
    }
  }

  /**
   * A quick reply on an opening question (PL-1).
   *
   * The user picked a category from the list they were shown, so it is recorded
   * straight away through the deterministic clarification route. There is no
   * card to accept: nothing was read from free text and nothing was guessed.
   */
  async function answerOpening(question: AssistantQuestion, choice: string) {
    if (!twin || isOffline || answered[question.question_id]) return;
    const obligationId = obligationForQuestion(twin, question);
    const category = categoryForLabel(choice);
    if (!obligationId || !category) return;

    setAnswered((current) => ({ ...current, [question.question_id]: "busy" }));
    try {
      const loaded = await respondToClarification(twin, {
        user_id: twin.user_id,
        obligation_id: obligationId,
        category,
      });
      applyTwin(loaded.data);
      setAnswered((current) => ({ ...current, [question.question_id]: choice }));
    } catch (error: unknown) {
      setAnswered((current) => {
        const next = { ...current };
        delete next[question.question_id];
        return next;
      });
      add({ kind: "error", text: errorText(error) });
    }
  }

  /** Accept or reject one draft. Accepting is the only write here (AS-15). */
  async function decide(proposal: Proposal, decision: "accept" | "reject") {
    if (!twin || isOffline) return;
    const id = proposal.proposal_id;
    // G-15: a second click while the first is in flight, or after the card has
    // been decided, must not send a second decision.
    const already = decisions[id];
    if (already?.isDeciding || already?.status === "accepted" || already?.status === "rejected") {
      return;
    }
    setDecisions((current) => ({
      ...current,
      [id]: { status: "pending", isDeciding: true },
    }));
    try {
      const response = await decideProposal(id, { decision });
      if (response.twin) applyTwin(response.twin);
      setDecisions((current) => ({ ...current, [id]: { status: response.status } }));
    } catch (error: unknown) {
      setDecisions((current) => ({
        ...current,
        [id]: { status: "pending", error: errorText(error) },
      }));
      // G-16: the twin the card was drafted against has moved on.
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        await refreshTwin(twin);
      }
    }
  }

  async function refreshTwin(current: FinancialTwin) {
    try {
      const loaded = await getTwin(current.user_id);
      if (loaded.source === "api") applyTwin(loaded.data);
    } catch {
      // The card already says what went wrong; a failed refresh adds nothing.
    }
  }

  /** "Ask again" clears the failed card and puts the cursor back in the composer. */
  function askAgain(proposalId: string) {
    setDecisions((current) => ({ ...current, [proposalId]: { status: "rejected" } }));
    composer.current?.focus();
  }

  const trimmed = text.trim();
  const isTooLong = text.length > MAX_CHARACTERS;
  const canSend = Boolean(twin) && !isSending && !isOffline && trimmed.length > 0 && !isTooLong;

  return (
    <Card
      title="TwinBank Assistant"
      subtitle="It drafts and asks. Nothing reaches your Financial Twin until you accept it."
    >
      <div
        role="log"
        aria-label="Assistant conversation"
        aria-live="polite"
        className="grid max-h-[28rem] gap-3 overflow-y-auto"
      >
        {entries.length === 0 ? <p className="text-sm text-muted">{OPENING_PROMPT}</p> : null}

        {entries.map((entry) => {
          if (entry.kind === "user") {
            return (
              <p
                key={entry.key}
                className="justify-self-end rounded-xl bg-raised px-3 py-2 text-sm text-ink"
              >
                <span className="sr-only">You said: </span>
                {entry.text}
              </p>
            );
          }

          if (entry.kind === "error") {
            return (
              <p key={entry.key} className="text-sm text-bad">
                {entry.text}
              </p>
            );
          }

          return (
            <div key={entry.key} className="grid gap-2">
              {entry.reply ? (
                <div className="rounded-xl border border-line bg-surface px-3 py-2">
                  <p className="text-sm text-ink">{entry.reply}</p>
                  {/* AS-4: never label rules output as a model's, or the reverse. */}
                  {entry.readBy ? (
                    <p className="mt-1 text-xs text-faint">
                      {entry.readBy === "model" ? "Read by model" : "Read by rules"}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {entry.proposals.map((proposal) => (
                <ProposalCard
                  key={proposal.proposal_id}
                  proposal={proposal}
                  twin={twin as FinancialTwin}
                  decision={decisions[proposal.proposal_id] ?? { status: "pending" }}
                  disabledReason={disabledReason}
                  onDecide={(decision) => void decide(proposal, decision)}
                  onAskAgain={() => askAgain(proposal.proposal_id)}
                />
              ))}

              {entry.questions.map((question) => {
                const choices = question.choices ?? [];
                const given = answered[question.question_id];
                const isOpening = entry.messageId === null;
                return (
                  <div
                    key={question.question_id}
                    className="rounded-xl border border-line bg-surface px-3 py-2"
                  >
                    <p className="text-sm text-ink">{question.text}</p>
                    {choices.length > 0 ? (
                      given && given !== "busy" ? (
                        <p className="mt-2 text-sm text-muted">Answered: {given}</p>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {choices.map((choice) => (
                            <button
                              key={choice}
                              type="button"
                              disabled={isOffline || isSending || given === "busy"}
                              title={disabledReason}
                              onClick={() =>
                                isOpening
                                  ? void answerOpening(question, choice)
                                  : void send(choice, entry.messageId)
                              }
                              className={quickReply}
                            >
                              {choice}
                            </button>
                          ))}
                        </div>
                      )
                    ) : null}
                  </div>
                );
              })}

              {/* AS-8: handed over filled in, never run, and with nothing said
                  about whether the purchase is affordable. */}
              {entry.prefill ? (
                <Link
                  href={simulateHref(entry.prefill)}
                  className={`${quickReply} justify-self-start`}
                >
                  Open in Purchase Simulator
                </Link>
              ) : null}
            </div>
          );
        })}
      </div>

      <form
        className="mt-4 grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(text, answering?.messageId ?? null);
        }}
      >
        {answering ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>Answering: {answering.question}</span>
            <button
              type="button"
              onClick={() => setAnswering(null)}
              className={`${button} border border-line text-ink hover:bg-raised`}
            >
              Cancel
            </button>
          </div>
        ) : null}

        <label className="sr-only" htmlFor="assistant-message">
          Message the Assistant
        </label>
        <textarea
          id="assistant-message"
          ref={composer}
          rows={2}
          value={text}
          // AS-13: no second message while one is in flight.
          disabled={isSending || isOffline}
          title={disabledReason}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter is a newline (PL-2).
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void send(text, answering?.messageId ?? null);
          }}
          placeholder={OPENING_PROMPT}
          className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-counter focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter disabled:cursor-not-allowed disabled:opacity-50"
        />

        <div className="flex items-center justify-between gap-3">
          {text.length >= COUNTER_FROM ? (
            <p className={`text-xs ${isTooLong ? "text-bad" : "text-muted"}`} aria-live="polite">
              {text.length} / {MAX_CHARACTERS} characters
            </p>
          ) : (
            <span />
          )}
          <button
            type="submit"
            disabled={!canSend}
            title={disabledReason}
            className={`${button} bg-counter text-canvas hover:brightness-110`}
          >
            {isSending ? "Reading…" : "Send"}
          </button>
        </div>
      </form>
    </Card>
  );
}
