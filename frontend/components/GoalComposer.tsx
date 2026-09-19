"use client";

/**
 * Goal entry in two steps: type it, read back what TwinBank parsed, confirm it.
 *
 * The second step is the feature, not overhead. The compiler asks a question
 * instead of inventing an amount or a deadline (SPEC §2), and this is where that
 * refusal becomes visible: the questions and the fragments it could not read are
 * shown next to the drafts, so nothing is saved that the user has not seen.
 *
 * Questions are read-only here. The text stays editable, so answering one means
 * saying it more precisely and compiling again.
 *
 * `onConfirm` is handed the *complete* declared set, merged here. The endpoint
 * behind it replaces everything it is sent, so confirming a bare draft would
 * erase the user's other goals and their emergency reserve — `lib/goals` is what
 * prevents that, and the review list below is the full set that will be saved.
 *
 * Props only: the page owns every call to the backend.
 */

import { useState, type FormEvent } from "react";
import { longDate, money } from "@/lib/format";
import { describeChange, mergeConstraints, mergeGoals, type GoalChange } from "@/lib/goals";
import type {
  DeclaredGoalsRequest,
  FinancialConstraint,
  Goal,
  GoalCompileResponse,
} from "@/lib/types";
import { Badge, Card } from "./ui";

const PLACEHOLDER = "I need $2,000 for summer housing by May 1st, and keep $300 in checking.";

const CHANGE_TONE = {
  new: "info",
  updated: "caution",
  unchanged: "neutral",
} as const satisfies Record<GoalChange, "info" | "caution" | "neutral">;

export function GoalComposer({
  goals,
  constraints,
  draft,
  isCompiling,
  isSaving,
  compileError,
  saveError,
  onCompile,
  onConfirm,
  onDiscard,
}: {
  /** The goals the twin holds now. The drafts are merged into these, not over them. */
  goals: Goal[];
  /** The constraints the twin holds now, including the emergency reserve. */
  constraints: FinancialConstraint[];
  /** The compiler's answer, or null while composing. */
  draft: GoalCompileResponse | null;
  isCompiling: boolean;
  isSaving: boolean;
  compileError?: string;
  saveError?: string;
  onCompile: (text: string) => void;
  onConfirm: (request: DeclaredGoalsRequest) => void;
  onDiscard: () => void;
}) {
  const [text, setText] = useState("");
  const canCompile = text.trim().length > 0 && !isCompiling;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canCompile) onCompile(text.trim());
  }

  return (
    <Card
      title="Add or change a goal"
      subtitle="Say it in your own words. TwinBank asks about anything it will not guess."
    >
      <form onSubmit={submit} className="grid gap-3">
        <label className="sr-only" htmlFor="goal-text">
          Describe the goal
        </label>
        <textarea
          id="goal-text"
          rows={3}
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          className="w-full resize-y rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-counter"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={!canCompile}
            className="rounded-lg bg-counter px-4 py-2 text-sm font-semibold text-canvas transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCompiling ? "Reading…" : draft ? "Read it again" : "Read this back to me"}
          </button>
          {draft ? (
            <button
              type="button"
              onClick={onDiscard}
              disabled={isSaving}
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-muted transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              Discard
            </button>
          ) : null}
        </div>
      </form>

      {compileError ? (
        <p className="mt-3 text-sm text-bad">
          Could not read that: {compileError}. Goals are compiled by the backend, so nothing
          was drafted.
        </p>
      ) : null}

      {draft ? (
        <Review
          goals={goals}
          constraints={constraints}
          draft={draft}
          isSaving={isSaving}
          saveError={saveError}
          onConfirm={onConfirm}
        />
      ) : null}
    </Card>
  );
}

function Review({
  goals,
  constraints,
  draft,
  isSaving,
  saveError,
  onConfirm,
}: {
  goals: Goal[];
  constraints: FinancialConstraint[];
  draft: GoalCompileResponse;
  isSaving: boolean;
  saveError?: string;
  onConfirm: (request: DeclaredGoalsRequest) => void;
}) {
  // Computed once and both shown and sent, so the list below cannot describe one
  // set while a different one is saved.
  const mergedGoals = mergeGoals(goals, draft.goals);
  const mergedConstraints = mergeConstraints(constraints, draft.constraints);
  const changes = describeChange(goals, mergedGoals);
  // Which rows the text is responsible for; the rest are carried through untouched.
  const fromText = new Set(draft.constraints.map((c) => c.type));

  const parsedNothing = draft.goals.length === 0 && draft.constraints.length === 0;

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          What TwinBank understood
        </h3>
        <Badge>{draft.compiler === "llm" ? "Read by the model" : "Read by rules"}</Badge>
      </div>

      {parsedNothing ? (
        <p className="text-sm text-caution">
          Nothing here is complete enough to save yet. Answer the question below in your own
          words and read it back again.
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs text-faint">
            The complete set that will be saved. Anything you did not mention is kept as it is.
          </p>
          <ul className="mb-4">
            {mergedGoals.map((goal) => (
              <li
                key={goal.id}
                className="flex items-baseline justify-between gap-4 border-b border-line/60 py-2 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{goal.name}</p>
                  <p className="text-xs text-faint">by {longDate(goal.deadline)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={CHANGE_TONE[changes.get(goal.id) ?? "unchanged"]}>
                    {changes.get(goal.id) ?? "unchanged"}
                  </Badge>
                  <span className="tnum text-sm text-ink">{money(goal.target_amount)}</span>
                </div>
              </li>
            ))}
            {mergedConstraints.map((constraint) => (
              <li
                key={constraint.id}
                className="flex items-baseline justify-between gap-4 border-b border-line/60 py-2 last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-sm text-ink">{constraint.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={fromText.has(constraint.type) ? "info" : "neutral"}>
                    {fromText.has(constraint.type) ? "from this" : "kept"}
                  </Badge>
                  <span className="tnum text-sm text-ink">{money(constraint.amount)}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {draft.clarifications.length > 0 ? (
        <div className="mb-4 rounded-lg border border-caution/40 bg-raised p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-caution">
            TwinBank will not guess these
          </p>
          <ul className="mt-2 grid gap-2">
            {draft.clarifications.map((clarification, index) => (
              <li key={`${clarification.field}-${index}`}>
                <p className="text-sm text-ink">{clarification.question}</p>
                <p className="text-xs text-faint">
                  about “{clarification.fragment}” ({clarification.field})
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {draft.unparsed.length > 0 ? (
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            Not read as a goal
          </p>
          <ul className="mt-1 grid gap-1">
            {draft.unparsed.map((fragment, index) => (
              <li key={`${fragment}-${index}`} className="text-sm text-faint">
                “{fragment}”
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {saveError ? <p className="mb-3 text-sm text-bad">Could not save: {saveError}</p> : null}

      <button
        type="button"
        onClick={() => onConfirm({ goals: mergedGoals, constraints: mergedConstraints })}
        disabled={parsedNothing || isSaving}
        className="rounded-lg bg-baseline px-4 py-2 text-sm font-semibold text-canvas transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSaving ? "Saving…" : "Confirm and update my twin"}
      </button>
    </div>
  );
}
