/**
 * The shell's header. Carries the pitch, the current page, and says plainly
 * where the data came from.
 *
 * Presentational: `AppShell` reads the twin and hands the facts down, so this
 * can be rendered in a test without a provider.
 */

import type { ReactNode } from "react";
import type { DataSource } from "@/lib/api";
import { provenanceLabel } from "@/lib/provenance";
import type { FinancialTwin } from "@/lib/types";
import { Badge } from "./ui";

export function Header({
  nav,
  pageTitle,
  userName,
  backend,
  twinSource,
  isMock,
}: {
  /** The menu control, which sits in the top-left corner of every page. */
  nav?: ReactNode;
  pageTitle?: string;
  userName?: string;
  /** Whether the backend answered. Reachability only. */
  backend?: DataSource;
  /** Where the twin's observed half came from, as the backend reported it. */
  twinSource?: FinancialTwin["source"];
  isMock?: boolean;
}) {
  // Two facts, one badge, never collapsed: a reachable backend with no Nessie
  // key still serves fixture data, and the header has to say so.
  const provenance = provenanceLabel(backend, twinSource);
  return (
    <header className="border-b border-line bg-surface/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div className="flex items-center gap-3">
          {nav}
          <div>
            <p className="text-lg font-semibold tracking-tight text-ink">TwinBank</p>
            {pageTitle ? (
              <p className="text-sm text-muted">{pageTitle}</p>
            ) : (
              <p className="text-sm text-muted">
                Your bank knows what happened.{" "}
                <span className="text-baseline">TwinBank shows what happens next.</span>
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {userName ? <Badge>Demo user: {userName}</Badge> : null}
          {provenance ? (
            <Badge tone={provenance.tone}>
              <span>{provenance.backend}</span>
              <span aria-hidden="true" className="px-1 text-faint">
                ·
              </span>
              <span>{provenance.data}</span>
            </Badge>
          ) : null}
          {isMock ? <Badge tone="caution">Mocked simulation</Badge> : null}
        </div>
      </div>
    </header>
  );
}
