"use client";

/**
 * One click-to-edit value: the read state is a button, the edit state an input
 * with Save and Cancel (G-12, G-17).
 *
 * The rules it exists to keep are easy to get subtly wrong per field, so they
 * live here once:
 *
 * * nothing saves on a keystroke — Enter, blur or Save commits, Escape cancels,
 * * an invalid value shows its message under the field and keeps what was typed
 *   (PL-11), so a typo is corrected rather than retyped,
 * * a value that did not actually change closes without a request,
 * * a second commit cannot start while the first is in flight (G-15),
 * * entering and leaving the edit state is announced (G-17).
 *
 * `onSave` returns whether the write succeeded: false keeps the field open with
 * the draft intact, so the caller's own error message (a 409, say) has something
 * to sit under.
 *
 * NOTE: `app/obligations/page.tsx` carries an equivalent private copy from
 * before this file existed. Folding it into this one is its own cleanup PR
 * (frontend/SPEC.md section 14) so two pages are not rewritten at once.
 */

import { useRef, useState, type ReactNode } from "react";

const CONTROL =
  "rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter disabled:cursor-not-allowed disabled:opacity-50";
const TEXT_BUTTON =
  "rounded-sm text-sm font-medium text-counter underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter disabled:cursor-not-allowed disabled:opacity-50";

export function InlineField({
  /** What this value belongs to, for the accessible names: "Summer housing". */
  ownerName,
  label,
  value,
  display,
  type = "text",
  min,
  max,
  placeholder,
  disabled,
  disabledTitle,
  validate,
  onSave,
}: {
  ownerName: string;
  label: string;
  /** The current value in the input's own format, not the formatted display. */
  value: string;
  display: ReactNode;
  type?: "text" | "number" | "date";
  min?: string | number;
  max?: string | number;
  placeholder?: string;
  disabled: boolean;
  disabledTitle?: string;
  validate: (draft: string) => string | undefined;
  onSave: (draft: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  // Seeded when editing opens, so a value refreshed underneath a closed field
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
        title={disabledTitle}
        aria-label={`Edit ${label.toLowerCase()} for ${ownerName}`}
        onClick={() => {
          setDraft(value);
          setError(undefined);
          setEditing(true);
        }}
        className={`${TEXT_BUTTON} max-w-full break-words text-left text-ink no-underline hover:underline`}
      >
        {display}
      </button>
    );
  }

  return (
    <div className="min-w-0">
      <span role="status" className="sr-only">
        Editing {label.toLowerCase()} for {ownerName}
      </span>
      <input
        autoFocus
        type={type}
        min={min}
        max={max}
        step={type === "number" ? "any" : undefined}
        placeholder={placeholder}
        value={draft}
        disabled={disabled}
        aria-label={`${label} for ${ownerName}`}
        aria-invalid={Boolean(error)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          // Tabbing to Save or Cancel must not commit first: a blur-then-click
          // would save the very draft Cancel is there to discard.
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
      {/* `onMouseDown` prevented for the same reason as the `onBlur` check above. */}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          data-inline-action="save"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void commit()}
          className={TEXT_BUTTON}
        >
          Save
        </button>
        <button
          type="button"
          data-inline-action="cancel"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={cancel}
          className={TEXT_BUTTON}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
