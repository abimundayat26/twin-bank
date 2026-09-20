/**
 * The shell's header. Carries the product identity, current page and user.
 *
 * Presentational: `AppShell` reads the twin and hands the facts down, so this
 * can be rendered in a test without a provider.
 */

import type { ReactNode } from "react";
import { Badge } from "./ui";

export function Header({
  nav,
  pageTitle,
  userName,
}: {
  /** The menu control, which sits in the top-left corner of every page. */
  nav?: ReactNode;
  pageTitle?: string;
  userName?: string;
}) {
  return (
    <header className="border-b border-on-shell/20 bg-shell text-on-shell">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div className="flex items-center gap-3">
          {nav}
          <div>
            <p className="text-lg font-semibold tracking-tight text-on-shell">TwinBank</p>
            {pageTitle ? (
              <p className="text-sm text-on-shell/75">{pageTitle}</p>
            ) : (
              <p className="text-sm text-on-shell/75">
                Your bank knows what happened.{" "}
                <span className="text-on-shell">TwinBank shows what happens next.</span>
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {userName ? <Badge surface="shell">{userName}</Badge> : null}
        </div>
      </div>
    </header>
  );
}
