"use client";

/**
 * Goal entry in two steps: type it, read back what TwinBank parsed, correct and
 * confirm it.
 *
 * The second step is the feature, not overhead. The compiler asks a question
 * instead of inventing an amount or a deadline (SPEC §2), and this is where that
 * refusal becomes visible: the questions and the fragments it could not read are
 * shown next to the drafts, so nothing is saved that the user has not seen.
 *
 * An answer is folded back into the user's own words and compiled again — the
 * compiler is stateless and reads only text, so there is nothing else to answer
 * to. The review rows are editable for the same reason: a number the compiler
 * read wrong is corrected here rather than by retyping the sentence. Rows the
 * text did not mention stay read-only, so confirming cannot rewrite a goal the
 * user was not talking about.
 *
 * `onConfirm` is handed the *complete* declared set, merged and edited here. The
 * endpoint behind it replaces everything it is sent, so confirming a bare draft
 * would erase the user's other goals and their emergency reserve — `lib/goals`
 * is what prevents that, and the review list below is the full set that will be
 * saved.
 *
 * Props only: the page owns every call to the backend.
 */

import { useState, type FormEvent } from "react";
import { longDate, money } from "@/lib/format";
import { GOALS_SCOPE } from "@/lib/scopes";
import {
  appendAnswers,
  applyEdits,
  describeChange,
  isEditValid,
  mergeConstraints,
  mergeGoals,
  validateEdit,
  type GoalChange,
  type GoalEdit,
  type GoalEdits,
} from "@/lib/goals";
import type {
  DeclaredGoalsRequest,
  FinancialConstraint,
  Goal,
  GoalClarification,
  GoalCompileResponse,
  IsoDate,
} from "@/lib/types";
import { Badge, Card } from "./ui";

/** Names this card's save, so only this button says "Saving…". */

const PLACEHOLDER = "I need $1,600 for summer housing by May 1st, and keep $300 in checking.";

const CHANGE_TONE = {
  new: "info",
  updated: "caution",
  unchanged: "neutral",
} as const satisfies Record<GoalChange, "info" | "caution" | "neutral">;

/** What to type into the box under each kind of question. */
const ANSWER_HINT: Record<GoalClarification["field"], string> = {
  amount: "e.g. $2,000",
  deadline: "e.g. May 1 2027, 2027-05-01, or in 6 months",
  name: "e.g. a laptop",
  type: "Say this part again in your own words",
  account: "e.g. checking",
  intent: "Say this part again in your own words",
};

const inputClass =
  "w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-counter";

export function GoalComposer({
  goals,
  constraints,
  asOf,
  draft,
  isCompiling,
  isBusy,
  savingScope,
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
  /** The twin's as_of date: every deadline must be after it. */
  asOf: IsoDate;
  /** The compiler's answer, or null while composing. */
  draft: GoalCompileResponse | null;
  isCompiling: boolean;
  /** A twin update is in flight somewhere on the page; no second one may start. */
  isBusy: boolean;
  /** Which control started it, so only that one says "Saving…". */
  savingScope?: string;
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

  /**
   * Answering puts the user's words back in the box before compiling them, so
   * what is read back is always the text they can still see and edit.
   */
  function answer(clarification: GoalClarification, said: string) {
    const next = appendAnswers(draft?.text ?? text, [{ clarification, answer: said }]);
    setText(next);
    onCompile(next);
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
          className={`${inputClass} resize-y`}
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
              disabled={isBusy}
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
        // Keyed by the text behind it: a different reading is a different review,
        // and corrections typed against the old one must not carry over.
        <Review
          key={draft.text}
          goals={goals}
          constraints={constraints}
          asOf={asOf}
          draft={draft}
          isCompiling={isCompiling}
          isBusy={isBusy}
          isSaving={savingScope === GOALS_SCOPE}
          saveError={saveError}
          onAnswer={answer}
          onConfirm={onConfirm}
        />
      ) : null}
    </Card>
  );
}

function Review({
  goals,
  constraints,
  asOf,
  draft,
  isCompiling,
  isBusy,
  isSaving,
  saveError,
  onAnswer,
  onConfirm,
}: {
  goals: Goal[];
  constraints: FinancialConstraint[];
  asOf: IsoDate;
  draft: GoalCompileResponse;
  isCompiling: boolean;
  isBusy: boolean;
  isSaving: boolean;
  saveError?: string;
  onAnswer: (clarification: GoalClarification, said: string) => void;
  onConfirm: (request: DeclaredGoalsRequest) => void;
}) {
  // Corrections typed into the rows, keyed by goal id and kept as raw strings:
  // a half-typed amount is not a number yet.
  const [edits, setEdits] = useState<GoalEdits>({});

  // Computed once and both shown and sent, so the list below cannot describe one
  // set while a different one is saved.
  const mergedGoals = mergeGoals(goals, draft.goals);
  const mergedConstraints = mergeConstraints(constraints, draft.constraints);
  // Against the drafted set, not the edited one, so a row cannot turn read-only
  // while it is being corrected.
  const changes = describeChange(goals, mergedGoals);
  const errors = new Map(
    mergedGoals.map((goal) => [goal.id, validateEdit(goal, edits[goal.id], asOf)] as const),
  );
  const editedGoals = applyEdits(mergedGoals, edits, asOf);
  const invalid = [...errors.values()].some((row) => !isEditValid(row));
  // Which constraint rows the text is responsible for; the rest are carried through.
  const fromText = new Set(draft.constraints.map((c) => c.type));

  const parsedNothing = draft.goals.length === 0 && draft.constraints.length === 0;

  function setField(goalId: string, field: keyof GoalEdit, value: string) {
    setEdits((previous) => ({ ...previous, [goalId]: { ...previous[goalId], [field]: value } }));
  }

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
            The complete set that will be saved. Correct anything TwinBank read wrong; anything
            you did not mention is kept as it is.
          </p>
          <ul className="mb-4">
            {editedGoals.map((goal) => {
              const change = changes.get(goal.id) ?? "unchanged";
              const editable = change !== "unchanged";
              const rowErrors = errors.get(goal.id) ?? {};
              const edit = edits[goal.id];
              return (
                <li key={goal.id} className="border-b border-line py-2 last:border-0">
                  <div className="flex items-baseline justify-between gap-4">
                    <p className="min-w-0 truncate text-sm text-ink">{goal.name}</p>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={CHANGE_TONE[change]}>{change}</Badge>
                      {editable ? null : (
                        <span className="tnum text-sm text-ink">{money(goal.target_amount)}</span>
                      )}
                    </div>
                  </div>

                  {editable ? (
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <Field
                        id={`${goal.id}-amount`}
                        label="Target amount"
                        error={rowErrors.target_amount}
                      >
                        <input
                          id={`${goal.id}-amount`}
                          type="number"
                          min={0}
                          step={25}
                          inputMode="decimal"
                          value={edit?.target_amount ?? String(goal.target_amount)}
                          onChange={(e) => setField(goal.id, "target_amount", e.target.value)}
                          className={`${inputClass} tnum`}
                        />
                      </Field>
                      <Field id={`${goal.id}-deadline`} label="Deadline" error={rowErrors.deadline}>
                        <input
                          id={`${goal.id}-deadline`}
                          type="date"
                          min={asOf}
                          value={edit?.deadline ?? goal.deadline}
                          onChange={(e) => setField(goal.id, "deadline", e.target.value)}
                          className={`${inputClass} tnum`}
                        />
                      </Field>
                      {/* Only on a new goal: an existing one keeps the progress the
                          twin already holds, and the compiler never reads it. */}
                      {change === "new" ? (
                        <Field
                          id={`${goal.id}-progress`}
                          label="Already saved toward this"
                          error={rowErrors.current_amount}
                        >
                          <input
                            id={`${goal.id}-progress`}
                            type="number"
                            min={0}
                            step={25}
                            inputMode="decimal"
                            placeholder="0"
                            value={edit?.current_amount ?? String(goal.current_amount)}
                            onChange={(e) => setField(goal.id, "current_amount", e.target.value)}
                            className={`${inputClass} tnum`}
                          />
                        </Field>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-xs text-faint">by {longDate(goal.deadline)}</p>
                  )}
                </li>
              );
            })}
            {mergedConstraints.map((constraint) => (
              <li
                key={constraint.id}
                className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0"
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
        <div className="mb-4 rounded-lg border border-caution/70 bg-raised p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-caution">
            TwinBank will not guess these
          </p>
          <ul className="mt-2 grid gap-3">
            {draft.clarifications.map((clarification, index) => (
              <Clarification
                key={`${clarification.field}-${index}`}
                clarification={clarification}
                index={index}
                isCompiling={isCompiling}
                onAnswer={onAnswer}
              />
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
        onClick={() => onConfirm({ goals: editedGoals, constraints: mergedConstraints })}
        disabled={parsedNothing || invalid || isBusy}
        className="rounded-lg bg-baseline px-4 py-2 text-sm font-semibold text-canvas transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSaving ? "Saving…" : "Confirm and update my twin"}
      </button>
      {invalid ? (
        <p className="mt-2 text-xs text-caution">Fix the highlighted field before saving.</p>
      ) : null}
    </div>
  );
}

/** One question with a box to answer it in. Answering compiles the text again. */
function Clarification({
  clarification,
  index,
  isCompiling,
  onAnswer,
}: {
  clarification: GoalClarification;
  index: number;
  isCompiling: boolean;
  onAnswer: (clarification: GoalClarification, said: string) => void;
}) {
  const [said, setSaid] = useState("");
  const inputId = `clarification-${clarification.field}-${index}`;
  const canAnswer = said.trim().length > 0 && !isCompiling;

  return (
    <li>
      <label htmlFor={inputId} className="text-sm text-ink">
        {clarification.question}
      </label>
      <p className="text-xs text-faint">
        about “{clarification.fragment}” ({clarification.field})
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          value={said}
          onChange={(e) => setSaid(e.target.value)}
          placeholder={ANSWER_HINT[clarification.field]}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canAnswer) {
              e.preventDefault();
              onAnswer(clarification, said);
            }
          }}
          className={`${inputClass} sm:w-64`}
        />
        <button
          type="button"
          disabled={!canAnswer}
          onClick={() => onAnswer(clarification, said)}
          className="shrink-0 rounded-lg border border-counter px-3 py-2 text-sm font-medium text-counter transition hover:bg-counter/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isCompiling ? "Reading…" : "Answer and read it again"}
        </button>
      </div>
    </li>
  );
}

/** A labelled input with room for the reason it cannot be saved. */
function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-xs text-faint">
        {label}
      </label>
      <div className="mt-0.5">{children}</div>
      {error ? <p className="mt-0.5 text-xs text-bad">{error}</p> : null}
    </div>
  );
}
