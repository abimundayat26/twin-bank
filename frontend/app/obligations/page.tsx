"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Card, PageFrame, PageHeading, ResponsiveTable } from "@/components/ui";
import {
  ApiError,
  createOneTimeObligation,
  createRecurringObligation,
  deleteOneTimeObligation,
  deleteRecurringObligation,
  getObligations,
  respondToClarification,
  updateOneTimeObligation,
  updateRecurringObligation,
  type Loaded,
} from "@/lib/api";
import { addDays } from "@/lib/dates";
import { DateText, money, ordinalDay } from "@/lib/format";
import { OFFLINE_REASON } from "@/lib/offline";
import { offlineObligations } from "@/lib/obligations";
import { useTwin } from "@/lib/state/TwinProvider";
import type {
  FinancialTwin,
  ObligationCategory,
  ObligationsPayload,
  OneTimeObligationChanges,
  OneTimeObligationRow,
  RecurringObligationChanges,
  RecurringObligationRow,
} from "@/lib/types";

const STALE_MESSAGE = "That changed. Please review and try again.";
const CONTROL =
  "rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON =
  "rounded-lg bg-counter px-3 py-2 text-sm font-semibold text-white transition hover:bg-counter/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON =
  "rounded-lg border border-counter px-3 py-2 text-sm font-semibold text-counter transition hover:bg-counter/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter disabled:cursor-not-allowed disabled:opacity-50";
const TEXT_BUTTON =
  "rounded-sm text-sm font-medium text-counter underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter disabled:cursor-not-allowed disabled:opacity-50";

type Section = "recurring" | "one-time";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateName(value: string): string | undefined {
  const length = value.trim().length;
  if (length === 0) return "Enter a name.";
  if (length > 80) return "Name must be 80 characters or fewer.";
}

function validateAmount(value: string): string | undefined {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "Amount must be greater than $0.";
  if (amount > 1_000_000_000) return "Amount must be $1,000,000,000 or less.";
}

function validateDueDay(value: string): string | undefined {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return "Due day must be a whole number from 1 to 31.";
  }
}

function validateDate(value: string, asOf: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Choose a due date.";
  if (value <= asOf) return `Due date must be after ${asOf}.`;
  const latest = addDays(asOf, 730);
  if (value > latest) return `Due date must be on or before ${latest}.`;
}

function validationMessage(messages: Array<string | undefined>): string | undefined {
  return messages.find((message): message is string => Boolean(message));
}

function SectionSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={`Loading ${label}`} className="min-h-64">
      <span className="sr-only">Loading {label}…</span>
      <div aria-hidden="true" className="space-y-3">
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-14 animate-pulse rounded-lg bg-raised" />
        ))}
      </div>
    </div>
  );
}

function SectionError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="min-h-40 rounded-lg border border-bad/40 bg-bad/5 p-4">
      <p role="alert" className="break-words text-sm text-bad">{message}</p>
      <button type="button" onClick={retry} className={`${SECONDARY_BUTTON} mt-4`}>
        Retry
      </button>
    </div>
  );
}

function SectionCard({
  title,
  addLabel,
  addDisabled,
  disabledTitle,
  onAdd,
  error,
  onRetry,
  loading,
  children,
}: {
  title: string;
  addLabel: string;
  addDisabled: boolean;
  disabledTitle?: string;
  onAdd: () => void;
  error?: string;
  onRetry: () => void;
  loading: boolean;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h2 className="break-words text-base font-semibold text-ink">{title}</h2>
        <button
          type="button"
          disabled={addDisabled}
          title={disabledTitle}
          onClick={onAdd}
          className={SECONDARY_BUTTON}
        >
          {addLabel}
        </button>
      </div>
      {error ? <SectionError message={error} retry={onRetry} /> : loading ? (
        <SectionSkeleton label={title.toLowerCase()} />
      ) : children}
    </Card>
  );
}

function InlineField({
  rowName,
  label,
  value,
  display,
  type = "text",
  min,
  max,
  disabled,
  disabledTitle,
  validate,
  onSave,
}: {
  rowName: string;
  label: string;
  value: string;
  display: ReactNode;
  type?: "text" | "number";
  min?: number;
  max?: number;
  disabled: boolean;
  disabledTitle?: string;
  validate: (draft: string) => string | undefined;
  onSave: (draft: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  // Seeded when editing starts, so a row refreshed underneath a closed field
  // cannot leave a stale draft behind.
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string>();
  const committing = useRef(false);

  async function commit() {
    if (committing.current) return;
    const message = validate(draft);
    setError(message);
    if (message) return;
    if (draft.trim() === value) {
      setEditing(false);
      return;
    }
    committing.current = true;
    try {
      if (await onSave(draft.trim())) setEditing(false);
    } finally {
      committing.current = false;
    }
  }

  function cancel() {
    setDraft(value);
    setError(undefined);
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        title={disabledTitle ?? (typeof display === "string" ? display : undefined)}
        aria-label={`Edit ${label.toLowerCase()} for ${rowName}`}
        onClick={() => {
          setDraft(value);
          setError(undefined);
          setEditing(true);
        }}
        className={`${TEXT_BUTTON} max-w-full break-words text-left text-ink`}
      >
        {display}
      </button>
    );
  }

  return (
    <div className="min-w-0">
      <span role="status" className="sr-only">Editing {label.toLowerCase()} for {rowName}</span>
      <input
        autoFocus
        type={type}
        min={min}
        max={max}
        step={type === "number" ? "any" : undefined}
        value={draft}
        disabled={disabled}
        aria-label={`${label} for ${rowName}`}
        aria-invalid={Boolean(error)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          const target = event.relatedTarget as HTMLElement | null;
          if (!target?.dataset.inlineAction) void commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
        className={`${CONTROL} w-full min-w-0`}
      />
      {error ? <p role="alert" className="mt-1 text-xs text-bad">{error}</p> : null}
      {/*
        `onMouseDown` is prevented so pressing either button does not blur the
        input first: a blur-then-click would commit the draft that Cancel is
        there to discard. Tabbing to them is covered by the `onBlur` check above.
      */}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" data-inline-action="save" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => void commit()} className={TEXT_BUTTON}>Save</button>
        <button type="button" data-inline-action="cancel" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={cancel} className={TEXT_BUTTON}>Cancel</button>
      </div>
    </div>
  );
}

interface WriteControls {
  disabled: boolean;
  disabledTitle?: string;
  write: (
    section: Section,
    request: () => Promise<Loaded<FinancialTwin>>,
  ) => Promise<boolean>;
}

function CategoryCell({
  row,
  controls,
  userId,
  twin,
}: {
  row: RecurringObligationRow;
  controls: WriteControls;
  userId: string;
  twin: FinancialTwin;
}) {
  const [open, setOpen] = useState(false);
  const options = row.options ?? [];

  async function choose(category: ObligationCategory) {
    const saved = await controls.write("recurring", () =>
      respondToClarification(twin, {
        user_id: userId,
        obligation_id: row.id,
        category,
      }),
    );
    if (saved) setOpen(false);
  }

  return (
    <div className="min-w-0">
      <p className="break-words text-sm text-ink">{row.category_label ?? "Unclassified"}</p>
      {row.needs_answer ? (
        <div className="mt-1">
          <button type="button" disabled={controls.disabled} title={controls.disabledTitle} aria-expanded={open} onClick={() => setOpen((value) => !value)} className={TEXT_BUTTON}>What is this?</button>
          {open ? (
            <select
              autoFocus
              value=""
              disabled={controls.disabled}
              aria-label={`Choose category for ${row.name}`}
              onChange={(event) => void choose(event.target.value as ObligationCategory)}
              className={`${CONTROL} mt-2 block w-full min-w-0`}
            >
              <option value="" disabled>Choose category</option>
              {options.map((option) => <option key={option.category} value={option.category}>{option.label}</option>)}
            </select>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RecurringAddRow({
  controls,
  userId,
  onCancel,
}: {
  controls: WriteControls;
  userId: string;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [mandatory, setMandatory] = useState(true);
  const [error, setError] = useState<string>();

  async function submit() {
    const message = validationMessage([validateName(name), validateAmount(amount), validateDueDay(dueDay)]);
    setError(message);
    if (message) return;
    if (await controls.write("recurring", () => createRecurringObligation(userId, {
      name: name.trim(),
      amount: Number(amount),
      due_day: Number(dueDay),
      mandatory,
    }))) onCancel();
  }

  return (
    <tr className="align-top" onKeyDown={(event: KeyboardEvent<HTMLTableRowElement>) => {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter") { event.preventDefault(); void submit(); }
    }}>
      <td data-label="Name" className="px-3 py-3">
        <label className="sr-only" htmlFor="recurring-new-name">Name</label>
        <input id="recurring-new-name" autoFocus value={name} maxLength={81} disabled={controls.disabled} onChange={(event) => setName(event.target.value)} className={`${CONTROL} w-full min-w-0`} />
      </td>
      <td data-label="Category" className="px-3 py-3">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={mandatory} disabled={controls.disabled} onChange={(event) => setMandatory(event.target.checked)} className="h-4 w-4 accent-counter focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter" />
          Mandatory
        </label>
      </td>
      <td data-label="Amount" className="px-3 py-3">
        <label className="sr-only" htmlFor="recurring-new-amount">Amount</label>
        <input id="recurring-new-amount" type="number" min="0" step="0.01" value={amount} disabled={controls.disabled} onChange={(event) => setAmount(event.target.value)} className={`${CONTROL} w-full min-w-0`} />
      </td>
      <td data-label="Frequency" className="px-3 py-3 text-sm text-ink">Monthly</td>
      <td data-label="Due day" className="px-3 py-3">
        <label className="sr-only" htmlFor="recurring-new-day">Due day</label>
        <input id="recurring-new-day" type="number" min="1" max="31" step="1" value={dueDay} disabled={controls.disabled} onChange={(event) => setDueDay(event.target.value)} className={`${CONTROL} w-full min-w-0`} />
      </td>
      <td data-label="Active" className="px-3 py-3 text-sm text-muted">After saving</td>
      <td data-label="Actions" className="px-3 py-3">
        {error ? <p role="alert" className="mb-2 text-xs text-bad">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={controls.disabled} onClick={() => void submit()} className={PRIMARY_BUTTON}>Save</button>
          <button type="button" disabled={controls.disabled} onClick={onCancel} className={TEXT_BUTTON}>Cancel</button>
        </div>
      </td>
    </tr>
  );
}

function RecurringTable({ rows, adding, setAdding, controls, userId, twin }: {
  rows: RecurringObligationRow[];
  adding: boolean;
  setAdding: (value: boolean) => void;
  controls: WriteControls;
  userId: string;
  twin: FinancialTwin;
}) {
  async function change(row: RecurringObligationRow, changes: RecurringObligationChanges) {
    return controls.write("recurring", () => updateRecurringObligation(userId, row.id, changes));
  }

  return (
    <>
      {rows.length === 0 && !adding ? <p className="text-sm text-muted">No recurring expenses.</p> : null}
      {rows.length > 0 || adding ? (
        <ResponsiveTable>
          <table aria-label="Recurring expenses" className="w-full table-fixed border-collapse">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="w-[19%] px-3 py-2">Name</th>
                <th scope="col" className="w-[16%] px-3 py-2">Category</th>
                <th scope="col" className="w-[13%] px-3 py-2">Amount</th>
                <th scope="col" className="w-[11%] px-3 py-2">Frequency</th>
                <th scope="col" className="w-[12%] px-3 py-2">Due day</th>
                <th scope="col" className="w-[13%] px-3 py-2">Active</th>
                <th scope="col" className="w-[16%] px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {adding ? <RecurringAddRow controls={controls} userId={userId} onCancel={() => setAdding(false)} /> : null}
              {rows.map((row) => (
                <tr key={row.id} className={`border-b border-line align-top last:border-0 ${row.active ? "" : "opacity-60"}`}>
                  <td data-label="Name" className="min-w-0 px-3 py-3">
                    <InlineField rowName={row.name} label="Name" value={row.name} display={row.name} disabled={controls.disabled} disabledTitle={controls.disabledTitle} validate={validateName} onSave={(name) => change(row, { name })} />
                  </td>
                  <td data-label="Category" className="min-w-0 px-3 py-3"><CategoryCell row={row} controls={controls} userId={userId} twin={twin} /></td>
                  <td data-label="Amount" className="px-3 py-3">
                    <InlineField rowName={row.name} label="Amount" value={String(row.amount)} display={money(row.amount)} type="number" min={0} disabled={controls.disabled} disabledTitle={controls.disabledTitle} validate={validateAmount} onSave={(amount) => change(row, { amount: Number(amount) })} />
                  </td>
                  <td data-label="Frequency" className="px-3 py-3 text-sm text-ink">Monthly</td>
                  <td data-label="Due day" className="px-3 py-3">
                    <InlineField rowName={row.name} label="Due day" value={String(row.due_day)} display={`the ${ordinalDay(row.due_day)}`} type="number" min={1} max={31} disabled={controls.disabled} disabledTitle={controls.disabledTitle} validate={validateDueDay} onSave={(dueDay) => change(row, { due_day: Number(dueDay) })} />
                  </td>
                  <td data-label="Active" className="px-3 py-3">
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input type="checkbox" role="switch" checked={row.active} disabled={controls.disabled} title={controls.disabledTitle} aria-label={`Active status for ${row.name}`} onChange={() => void change(row, { active: !row.active })} className="h-4 w-4 accent-counter focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter" />
                      {row.active ? "Active" : "Paused"}
                    </label>
                  </td>
                  <td data-label="Actions" className="px-3 py-3">
                    {row.origin === "declared" ? (
                      <button type="button" disabled={controls.disabled} title={controls.disabledTitle} onClick={() => {
                        if (window.confirm(`Delete ${row.name}?`)) void controls.write("recurring", () => deleteRecurringObligation(userId, row.id));
                      }} className={TEXT_BUTTON}>Delete</button>
                    ) : <span className="text-sm text-muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      ) : null}
    </>
  );
}

interface OneTimeDraft {
  name: string;
  amount: string;
  dueDate: string;
  accountId: string;
  mandatory: boolean;
}

function validateOneTime(draft: OneTimeDraft, asOf: string, accountIds: Set<string>) {
  return validationMessage([
    validateName(draft.name),
    validateAmount(draft.amount),
    validateDate(draft.dueDate, asOf),
    accountIds.has(draft.accountId) ? undefined : "Choose an account.",
  ]);
}

function OneTimeFields({ prefix, draft, setDraft, accounts, asOf, disabled }: {
  prefix: string;
  draft: OneTimeDraft;
  setDraft: (draft: OneTimeDraft) => void;
  accounts: FinancialTwin["accounts"];
  asOf: string;
  disabled: boolean;
}) {
  return (
    <>
      <td data-label="Name" className="px-3 py-3">
        <label className="sr-only" htmlFor={`${prefix}-name`}>Name</label>
        <input id={`${prefix}-name`} autoFocus value={draft.name} maxLength={81} disabled={disabled} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className={`${CONTROL} w-full min-w-0`} />
      </td>
      <td data-label="Amount" className="px-3 py-3">
        <label className="sr-only" htmlFor={`${prefix}-amount`}>Amount</label>
        <input id={`${prefix}-amount`} type="number" min="0" step="0.01" value={draft.amount} disabled={disabled} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} className={`${CONTROL} w-full min-w-0`} />
      </td>
      <td data-label="Due date" className="px-3 py-3">
        <label className="sr-only" htmlFor={`${prefix}-date`}>Due date</label>
        <input id={`${prefix}-date`} type="date" min={addDays(asOf, 1)} max={addDays(asOf, 730)} value={draft.dueDate} disabled={disabled} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })} className={`${CONTROL} w-full min-w-0`} />
      </td>
      <td data-label="Account" className="px-3 py-3">
        <label className="sr-only" htmlFor={`${prefix}-account`}>Account</label>
        <select id={`${prefix}-account`} value={draft.accountId} disabled={disabled} onChange={(event) => setDraft({ ...draft, accountId: event.target.value })} className={`${CONTROL} w-full min-w-0`}>
          <option value="" disabled>Choose account</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
        </select>
        <label className="mt-2 flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={draft.mandatory} disabled={disabled} onChange={(event) => setDraft({ ...draft, mandatory: event.target.checked })} className="h-4 w-4 accent-counter focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter" />
          Mandatory
        </label>
      </td>
    </>
  );
}

function OneTimeAddRow({ controls, userId, twin, onCancel }: {
  controls: WriteControls;
  userId: string;
  twin: FinancialTwin;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<OneTimeDraft>({ name: "", amount: "", dueDate: "", accountId: "", mandatory: true });
  const [error, setError] = useState<string>();

  async function submit() {
    const message = validateOneTime(draft, twin.as_of, new Set(twin.accounts.map((a) => a.id)));
    setError(message);
    if (message) return;
    if (await controls.write("one-time", () => createOneTimeObligation(userId, {
      name: draft.name.trim(), amount: Number(draft.amount), due_date: draft.dueDate,
      account_id: draft.accountId, mandatory: draft.mandatory,
    }))) onCancel();
  }

  return (
    <tr className="align-top" onKeyDown={(event: KeyboardEvent<HTMLTableRowElement>) => {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter") { event.preventDefault(); void submit(); }
    }}>
      <OneTimeFields prefix="one-time-new" draft={draft} setDraft={setDraft} accounts={twin.accounts} asOf={twin.as_of} disabled={controls.disabled} />
      <td data-label="Actions" className="px-3 py-3">
        {error ? <p role="alert" className="mb-2 text-xs text-bad">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={controls.disabled} onClick={() => void submit()} className={PRIMARY_BUTTON}>Save</button>
          <button type="button" disabled={controls.disabled} onClick={onCancel} className={TEXT_BUTTON}>Cancel</button>
        </div>
      </td>
    </tr>
  );
}

function OneTimeRow({ row, controls, userId, twin }: {
  row: OneTimeObligationRow;
  controls: WriteControls;
  userId: string;
  twin: FinancialTwin;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<OneTimeDraft>({ name: row.name, amount: String(row.amount), dueDate: row.due_date, accountId: row.account_id, mandatory: row.mandatory });
  const [error, setError] = useState<string>();

  function cancel() {
    setDraft({ name: row.name, amount: String(row.amount), dueDate: row.due_date, accountId: row.account_id, mandatory: row.mandatory });
    setError(undefined);
    setEditing(false);
  }

  async function submit() {
    const message = validateOneTime(draft, twin.as_of, new Set(twin.accounts.map((a) => a.id)));
    setError(message);
    if (message) return;
    const changes: OneTimeObligationChanges = {
      name: draft.name.trim(), amount: Number(draft.amount), due_date: draft.dueDate,
      account_id: draft.accountId, mandatory: draft.mandatory,
    };
    if (await controls.write("one-time", () => updateOneTimeObligation(userId, row.id, changes))) setEditing(false);
  }

  if (editing) {
    return (
      <tr className="border-b border-line align-top last:border-0" onKeyDown={(event: KeyboardEvent<HTMLTableRowElement>) => {
        if (event.key === "Escape") cancel();
        if (event.key === "Enter") { event.preventDefault(); void submit(); }
      }}>
        <OneTimeFields prefix={`one-time-${row.id}`} draft={draft} setDraft={setDraft} accounts={twin.accounts} asOf={twin.as_of} disabled={controls.disabled} />
        <td data-label="Actions" className="px-3 py-3">
          <span role="status" className="sr-only">Editing {row.name}</span>
          {error ? <p role="alert" className="mb-2 text-xs text-bad">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={controls.disabled} onClick={() => void submit()} className={PRIMARY_BUTTON}>Save</button>
            <button type="button" disabled={controls.disabled} onClick={cancel} className={TEXT_BUTTON}>Cancel</button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-line align-top last:border-0">
      <td data-label="Name" className="min-w-0 px-3 py-3 text-sm text-ink"><span className="block break-words" title={row.name}>{row.name}</span></td>
      <td data-label="Amount" className="tnum px-3 py-3 text-sm text-ink">{money(row.amount)}</td>
      <td data-label="Due date" className="px-3 py-3 text-sm text-ink"><DateText date={row.due_date} asOf={twin.as_of} /></td>
      <td data-label="Account" className="min-w-0 px-3 py-3 text-sm text-ink"><span className="block break-words" title={row.account_name}>{row.account_name}</span></td>
      <td data-label="Actions" className="px-3 py-3">
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={controls.disabled} title={controls.disabledTitle} onClick={() => setEditing(true)} className={TEXT_BUTTON}>Edit</button>
          <button type="button" disabled={controls.disabled} title={controls.disabledTitle} onClick={() => {
            if (window.confirm(`Delete ${row.name}?`)) void controls.write("one-time", () => deleteOneTimeObligation(userId, row.id));
          }} className={TEXT_BUTTON}>Delete</button>
        </div>
      </td>
    </tr>
  );
}

function OneTimeTable({ rows, adding, setAdding, controls, userId, twin }: {
  rows: OneTimeObligationRow[];
  adding: boolean;
  setAdding: (value: boolean) => void;
  controls: WriteControls;
  userId: string;
  twin: FinancialTwin;
}) {
  return (
    <>
      {rows.length === 0 && !adding ? <p className="text-sm text-muted">Nothing upcoming.</p> : null}
      {rows.length > 0 || adding ? (
        <ResponsiveTable>
          <table aria-label="Upcoming obligations" className="w-full table-fixed border-collapse">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="w-[24%] px-3 py-2">Name</th>
                <th scope="col" className="w-[16%] px-3 py-2">Amount</th>
                <th scope="col" className="w-[20%] px-3 py-2">Due date</th>
                <th scope="col" className="w-[22%] px-3 py-2">Account</th>
                <th scope="col" className="w-[18%] px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {adding ? <OneTimeAddRow controls={controls} userId={userId} twin={twin} onCancel={() => setAdding(false)} /> : null}
              {rows.map((row) => <OneTimeRow key={row.id} row={row} controls={controls} userId={userId} twin={twin} />)}
            </tbody>
          </table>
        </ResponsiveTable>
      ) : null}
    </>
  );
}

export default function ObligationsPage() {
  const { twin, twinError, isOffline, isBusy, applyTwin, refreshTwin } = useTwin();
  const [attempt, setAttempt] = useState(0);
  const [listing, setListing] = useState<ObligationsPayload>();
  const [listError, setListError] = useState<string>();
  const [addingRecurring, setAddingRecurring] = useState(false);
  const [addingOneTime, setAddingOneTime] = useState(false);
  const [writing, setWriting] = useState<Section>();
  const [recurringWriteError, setRecurringWriteError] = useState<string>();
  const [oneTimeWriteError, setOneTimeWriteError] = useState<string>();
  const writeLock = useRef(false);

  /**
   * Every write replaces the twin (OB-12), which re-runs this and re-reads the
   * ordered listing. The rows already on screen stay up while that request is in
   * flight: blanking them would drop the section back to a skeleton after every
   * edit and hide the message the write just produced. Only a failure clears
   * them, because a stale table under an error message is a lie (G-9).
   *
   * Offline there is no request at all; the listing is derived below from the
   * twin already in hand.
   */
  useEffect(() => {
    if (!twin || isOffline) return;
    let cancelled = false;
    getObligations(twin.user_id)
      .then((loaded) => {
        if (cancelled) return;
        setListing(loaded.data);
        setListError(undefined);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setListing(undefined);
        setListError(errorText(error));
      });
    return () => { cancelled = true; };
  }, [attempt, isOffline, twin]);

  async function write(section: Section, request: () => Promise<Loaded<FinancialTwin>>): Promise<boolean> {
    if (!twin || isOffline || isBusy || writeLock.current) return false;
    writeLock.current = true;
    setWriting(section);
    const setError = section === "recurring" ? setRecurringWriteError : setOneTimeWriteError;
    setError(undefined);
    try {
      const loaded = await request();
      applyTwin(loaded.data);
      return true;
    } catch (error: unknown) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        setError(STALE_MESSAGE);
        try { await refreshTwin(); } catch { /* Retry remains available. */ }
      } else {
        setError(errorText(error));
      }
      return false;
    } finally {
      writeLock.current = false;
      setWriting(undefined);
    }
  }

  // G-10: offline reshapes the saved twin rather than requesting anything, so a
  // request error from before the backend went away is not shown against it.
  const offlinePayload = useMemo(
    () => (isOffline && twin ? offlineObligations(twin) : undefined),
    [isOffline, twin],
  );
  const payload = isOffline ? offlinePayload : listing;
  const loadError = twinError ?? (isOffline ? undefined : listError);
  const loading = !payload && !loadError;
  const disabled = isOffline || isBusy || Boolean(writing);
  const disabledTitle = isOffline ? OFFLINE_REASON : undefined;
  const controls: WriteControls = { disabled, disabledTitle, write };
  // The twin is loaded once, by the provider, and has no retry of its own.
  const retry = twinError
    ? () => window.location.reload()
    : () => {
        setListError(undefined);
        setAttempt((value) => value + 1);
      };

  return (
    <PageFrame>
      <PageHeading title="Obligations">Review recurring expenses and upcoming obligations.</PageHeading>
      <div className="space-y-6">
        <SectionCard title="Recurring expenses" addLabel="Add recurring expense" addDisabled={disabled || addingRecurring || !twin} disabledTitle={disabledTitle} onAdd={() => setAddingRecurring(true)} error={loadError} onRetry={retry} loading={loading}>
          {payload && twin ? (
            <>
              {recurringWriteError ? <p role="alert" className="mb-3 break-words text-sm text-bad">{recurringWriteError}</p> : null}
              <RecurringTable rows={payload.recurring ?? []} adding={addingRecurring} setAdding={setAddingRecurring} controls={controls} userId={twin.user_id} twin={twin} />
            </>
          ) : null}
        </SectionCard>
        <SectionCard title="Upcoming obligations" addLabel="Add upcoming obligation" addDisabled={disabled || addingOneTime || !twin} disabledTitle={disabledTitle} onAdd={() => setAddingOneTime(true)} error={loadError} onRetry={retry} loading={loading}>
          {payload && twin ? (
            <>
              {oneTimeWriteError ? <p role="alert" className="mb-3 break-words text-sm text-bad">{oneTimeWriteError}</p> : null}
              <OneTimeTable rows={payload.one_time ?? []} adding={addingOneTime} setAdding={setAddingOneTime} controls={controls} userId={twin.user_id} twin={twin} />
            </>
          ) : null}
        </SectionCard>
      </div>
    </PageFrame>
  );
}
