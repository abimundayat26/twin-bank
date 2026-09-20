/** Small presentational primitives shared by the panels. No data access here. */

import type { ReactNode } from "react";
import type { Provenance } from "@/lib/types";

export function Card({
  title,
  subtitle,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-line bg-surface p-5 shadow-sm ${className}`}
    >
      {title ? (
        <header className="mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
            {title}
          </h2>
          {subtitle ? <p className="mt-1 text-xs text-faint">{subtitle}</p> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "caution" | "bad" | "info";
}) {
  const tones = {
    neutral: "border-line text-muted",
    good: "border-good/70 text-good",
    caution: "border-caution/70 text-caution",
    bad: "border-bad/70 bg-bad/10 text-bad",
    info: "border-counter/70 text-counter",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * TwinBank never claims to infer a personal goal from transactions, so every
 * fact says whether the bank observed it or Alex declared it.
 */
export function ProvenanceTag({ provenance }: { provenance: Provenance }) {
  return (
    <Badge tone={provenance === "declared" ? "info" : "neutral"}>
      {provenance === "declared" ? "You declared" : "Observed"}
    </Badge>
  );
}

export function Row({
  label,
  hint,
  value,
  meta,
}: {
  label: string;
  hint?: string;
  value: string;
  meta?: ReactNode;
}) {
  return (
    // Stacks on a narrow viewport and wraps rather than truncating: a clipped
    // account, obligation or goal name is unrecoverable for a sighted user, and
    // SPEC section 7.1 requires these rows to survive long financial labels.
    <li className="flex flex-col gap-2 border-b border-line py-2 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="break-words text-sm text-ink">{label}</p>
        {hint ? <p className="text-xs text-faint">{hint}</p> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:shrink-0">
        {meta}
        <span className="tnum break-words text-right text-sm text-ink">{value}</span>
      </div>
    </li>
  );
}
