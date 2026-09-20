"use client";

/**
 * The Goals & Limits side-panel on Plans & Assistant (frontend/SPEC.md PL-9 to
 * PL-13).
 *
 * It holds exactly two things: the goals the user declared, and the two limits
 * every projection has to respect. Nothing else — no accounts, no obligations,
 * no forecast (PL-13). Those have their own pages, and a side-panel that drifts
 * into a second dashboard is the thing the minimalist layout exists to avoid.
 *
 * Goals are *created* only in the chat (PL-10). Typing a goal is where the
 * declared-versus-observed line is drawn, and that conversation is the
 * Assistant's job; this panel only corrects what is already there.
 *
 * Every edit is a partial write: `PATCH /goals/{id}`, `DELETE /goals/{id}`,
 * `PUT /reserve`, `PUT /minimum-balance`. The replace-all `PUT /goals` is
 * deliberately not used here (PL-10) — a stale panel would otherwise overwrite a
 * goal the Assistant added in the meantime.
 */

import { useState } from "react";
import {
  ApiError,
  deleteGoal,
  setMinimumBalance,
  setReserve,
  updateGoal,
  type Loaded,
} from "@/lib/api";
import { addDays } from "@/lib/dates";
import { DateText, money } from "@/lib/format";
import { parseMoney, validateEdit } from "@/lib/goals";
import { OFFLINE_REASON } from "@/lib/offline";
import { useTwin } from "@/lib/state/TwinProvider";
import {
  DEFAULT_LOW_BALANCE_THRESHOLD,
  type FinancialConstraint,
  type FinancialTwin,
  type Goal,
  type GoalChanges,
} from "@/lib/types";
import { InlineField } from "./InlineField";
import { Card } from "./ui";

const STALE_MESSAGE = "That changed. Please review and try again.";
/** API-4: the backend refuses anything larger, NaN or infinite. */
const MAX_MONEY = 1_000_000_000;
/** G-11, and the engine's MAX_HORIZON_DAYS: a goal cannot be further out. */
const MAX_HORIZON_DAYS = 730;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared by both limits: a plain non-negative number of dollars. */
function validateLimit(draft: string): string | undefined {
  const amount = parseMoney(draft);
  if (amount === null) return "Enter an amount in dollars.";
  if (amount < 0) return "This cannot be negative.";
  if (amount > MAX_MONEY) return "That is larger than TwinBank can hold.";
  return undefined;
}

function GoalRow({
  goal,
  userId,
  asOf,
  disabled,
  disabledTitle,
  write,
}: {
  goal: Goal;
  userId: string;
  asOf: string;
  disabled: boolean;
  disabledTitle?: string;
  write: (request: () => Promise<Loaded<FinancialTwin>>) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const latestDeadline = addDays(asOf, MAX_HORIZON_DAYS);

  /** The composer's rules, so a correction is judged exactly as a draft was. */
  function checkDeadline(draft: string): string | undefined {
    const message = validateEdit(goal, { deadline: draft }, asOf).deadline;
    if (message) return message;
    return draft > latestDeadline ? `Pick a date on or before ${latestDeadline}.` : undefined;
  }

  function patch(changes: GoalChanges) {
    return write(() => updateGoal(userId, goal.id, changes));
  }

  return (
    <li className="border-b border-line py-4 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words font-medium text-ink">{goal.name}</p>
        {confirming ? null : (
          <button
            type="button"
            aria-label={`Delete goal ${goal.name}`}
            title={disabledTitle}
            disabled={disabled}
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded-md px-2 py-1 text-muted transition hover:text-bad focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>

      {confirming ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="mr-auto text-muted">Delete this goal?</span>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-lg border border-line px-3 py-1.5 text-muted transition hover:text-ink"
          >
            Keep it
          </button>
          <button
            type="button"
            disabled={disabled}
            title={disabledTitle}
            onClick={() => {
              void write(() => deleteGoal(userId, goal.id)).then((ok) => {
                if (!ok) setConfirming(false);
              });
            }}
            className="rounded-lg border border-bad/70 px-3 py-1.5 font-semibold text-bad transition hover:bg-bad/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      ) : null}

      <dl className="mt-3 grid gap-3 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <dt className="text-muted">Target amount</dt>
          <dd className="min-w-0 text-right">
            <InlineField
              ownerName={goal.name}
              label="Target amount"
              type="number"
              min={0}
              value={String(goal.target_amount)}
              display={<span className="tnum">{money(goal.target_amount)}</span>}
              disabled={disabled}
              disabledTitle={disabledTitle}
              validate={(draft) => validateEdit(goal, { target_amount: draft }, asOf).target_amount}
              onSave={(draft) => patch({ target_amount: parseMoney(draft) ?? 0 })}
            />
          </dd>
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <dt className="text-muted">Target date</dt>
          <dd className="min-w-0 text-right">
            <InlineField
              ownerName={goal.name}
              label="Target date"
              type="date"
              min={addDays(asOf, 1)}
              max={latestDeadline}
              value={goal.deadline}
              display={<DateText date={goal.deadline} asOf={asOf} />}
              disabled={disabled}
              disabledTitle={disabledTitle}
              validate={checkDeadline}
              onSave={(draft) => patch({ deadline: draft })}
            />
          </dd>
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {/* A4: the user's own figure. TwinBank does not infer progress from
              savings, which would be guessing which dollars are spoken for. */}
          <dt className="text-muted">Saved so far</dt>
          <dd className="min-w-0 text-right">
            <InlineField
              ownerName={goal.name}
              label="Saved so far"
              type="number"
              min={0}
              value={String(goal.current_amount)}
              display={<span className="tnum">{money(goal.current_amount)}</span>}
              disabled={disabled}
              disabledTitle={disabledTitle}
              validate={(draft) =>
                validateEdit(goal, { current_amount: draft }, asOf).current_amount
              }
              onSave={(draft) => patch({ current_amount: parseMoney(draft) ?? 0 })}
            />
          </dd>
        </div>
      </dl>
    </li>
  );
}

function LimitRow({
  label,
  caption,
  constraint,
  fallbackDisplay,
  disabled,
  disabledTitle,
  onSave,
}: {
  label: string;
  caption: string;
  constraint?: FinancialConstraint;
  /** Shown when nothing is declared: "Not set", or the default in force. */
  fallbackDisplay: string;
  disabled: boolean;
  disabledTitle?: string;
  onSave: (amount: number) => Promise<boolean>;
}) {
  return (
    <div className="border-b border-line py-4 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted">{label}</p>
        <div className="min-w-0 text-right">
          <InlineField
            ownerName={label}
            label="Amount"
            type="number"
            min={0}
            placeholder="0"
            value={constraint ? String(constraint.amount) : ""}
            display={
              constraint ? (
                <span className="tnum">{money(constraint.amount)}</span>
              ) : (
                <span className="text-muted">{fallbackDisplay}</span>
              )
            }
            disabled={disabled}
            disabledTitle={disabledTitle}
            validate={validateLimit}
            onSave={(draft) => onSave(parseMoney(draft) ?? 0)}
          />
        </div>
      </div>
      <p className="mt-1 text-xs text-faint">{caption}</p>
    </div>
  );
}

export function GoalsLimitsPanel() {
  const { twin, isOffline, isBusy, applyTwin, refreshTwin } = useTwin();
  const [open, setOpen] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string>();

  if (!twin) return null;

  // Soonest first: that deadline is where the simulation ends.
  const goals = [...twin.goals].sort((a, b) => a.deadline.localeCompare(b.deadline));
  const reserve = twin.constraints.find((c) => c.type === "minimum_reserve");
  const minimum = twin.constraints.find((c) => c.type === "minimum_checking_balance");
  const disabled = isOffline || isBusy || writing;
  const disabledTitle = isOffline ? OFFLINE_REASON : undefined;

  /**
   * One write at a time, replacing the twin with what the backend saved (API-2).
   * G-16: a 404 or 409 means the thing being edited moved under the reader, so
   * the twin is re-read and they are asked to look again rather than shown a
   * value that no longer exists.
   */
  async function write(request: () => Promise<Loaded<FinancialTwin>>): Promise<boolean> {
    if (disabled) return false;
    setWriting(true);
    setError(undefined);
    try {
      const loaded = await request();
      applyTwin(loaded.data);
      return true;
    } catch (caught: unknown) {
      if (caught instanceof ApiError && (caught.status === 404 || caught.status === 409)) {
        setError(STALE_MESSAGE);
        try {
          await refreshTwin();
        } catch {
          /* The panel keeps what it has; the next edit retries. */
        }
      } else {
        setError(errorText(caught));
      }
      return false;
    } finally {
      setWriting(false);
    }
  }

  return (
    <aside className="min-w-0 lg:w-80 lg:shrink-0" aria-labelledby="goals-limits-heading">
      {/* Below 1024px the panel starts collapsed so the chat owns the screen; the
          toggle carries the goal count so it says what it is hiding (section 9.2). */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="goals-limits"
        className="mb-3 w-full rounded-lg border border-line px-4 py-2.5 text-left text-sm font-semibold text-ink transition hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter lg:hidden"
      >
        {open ? "Hide" : "Show"} goals &amp; limits ({goals.length})
      </button>

      <div id="goals-limits" className={`${open ? "block" : "hidden"} lg:block`}>
        <h2 id="goals-limits-heading" className="sr-only">
          Goals and limits
        </h2>

        {error ? (
          <p role="alert" className="mb-3 break-words text-sm text-bad">
            {error}
          </p>
        ) : null}

        <div className="grid gap-4">
          <Card title="Goals">
            {goals.length ? (
              <ul>
                {goals.map((goal) => (
                  <GoalRow
                    key={goal.id}
                    goal={goal}
                    userId={twin.user_id}
                    asOf={twin.as_of}
                    disabled={disabled}
                    disabledTitle={disabledTitle}
                    write={write}
                  />
                ))}
              </ul>
            ) : (
              // PL-12. It names where a goal comes from, because there is no
              // "New goal" button here by design (PL-10).
              <p className="text-sm text-muted">No goals yet. Tell the Assistant about one.</p>
            )}
          </Card>

          <Card title="Limits">
            <LimitRow
              label="Emergency reserve"
              caption="Checking plus savings."
              constraint={reserve}
              fallbackDisplay="Not set"
              disabled={disabled}
              disabledTitle={disabledTitle}
              onSave={(amount) => write(() => setReserve(twin.user_id, { amount }))}
            />
            <LimitRow
              label="Minimum checking balance"
              caption="Checking only. Where a “low balance” starts for you."
              constraint={minimum}
              fallbackDisplay={`${money(DEFAULT_LOW_BALANCE_THRESHOLD)} (default)`}
              disabled={disabled}
              disabledTitle={disabledTitle}
              onSave={(amount) => write(() => setMinimumBalance(twin, { amount }))}
            />
          </Card>
        </div>
      </div>
    </aside>
  );
}
