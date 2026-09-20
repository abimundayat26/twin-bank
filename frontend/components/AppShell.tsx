"use client";

/**
 * The shell every page sits inside: primary navigation, product identity, the
 * current page, the display name and the persistent offline state (G-10/G-25).
 *
 * This is the one place that reads the twin for the chrome, so each page can
 * stay about its own job. It is deliberately short: the shell must not take so
 * much vertical space that a page's primary content falls below the fold.
 */

import { usePathname } from "next/navigation";
import { destinationFor } from "@/lib/navigation";
import { OFFLINE_REASON } from "@/lib/offline";
import { useTwin } from "@/lib/state/TwinProvider";
import { Header } from "./Header";
import { Nav } from "./Nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { twin, isOffline } = useTwin();
  const destination = destinationFor(pathname);

  return (
    <>
      <Header
        nav={<Nav />}
        pageTitle={destination?.label}
        userName={twin?.display_name}
      />
      {isOffline ? (
        <div
          role="status"
          className="border-b border-caution/40 bg-surface px-4 py-2 text-center text-sm font-medium text-caution sm:px-6"
        >
          {OFFLINE_REASON}
        </div>
      ) : null}
      {children}
    </>
  );
}
