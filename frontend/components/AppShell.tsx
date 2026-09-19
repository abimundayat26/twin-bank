"use client";

/**
 * The shell every page sits inside: the menu control, the product identity, the
 * current page's title, who the demo user is, and where the data came from
 * (SPEC section 2.2).
 *
 * This is the one place that reads the twin for the chrome, so each page can
 * stay about its own job. It is deliberately short: the shell must not take so
 * much vertical space that a page's primary content falls below the fold.
 */

import { usePathname } from "next/navigation";
import { destinationFor } from "@/lib/navigation";
import { useTwin } from "@/lib/state/TwinProvider";
import { Header } from "./Header";
import { Nav } from "./Nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { twin, source, simulation } = useTwin();
  const destination = destinationFor(pathname);

  return (
    <>
      <Header
        nav={<Nav />}
        pageTitle={destination?.label}
        userName={twin?.display_name}
        backend={source}
        twinSource={twin?.source}
        isMock={simulation?.is_mock}
      />
      {children}
    </>
  );
}
