"use client";

/**
 * The primary menu, opened from the top-left control on every page.
 *
 * A drawer at every width rather than a sidebar that appears and disappears:
 * one behaviour is easier to keep accessible, and SPEC section 2.1 allows it.
 * The control stays in the same corner everywhere, so the user never hunts for
 * it (section 2.1), and the drawer closes after navigating so it can never sit
 * on top of the page's own actions.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DESTINATIONS, isCurrent } from "@/lib/navigation";

export function Nav() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape closes, and focus goes back to the control that opened it, so a
  // keyboard user is never left with focus on a hidden panel.
  //
  // Tab wraps inside the drawer for the same reason. The scrim covers the page,
  // so a control behind it can be focused but neither seen nor clicked; letting
  // Tab walk out of the drawer strands a keyboard user there (SPEC section 7:
  // drawers stay fully reachable, and focused controls stay visible).
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !(active instanceof Node) || !panel.contains(active);
      if (event.shiftKey ? active === first || outside : active === last || outside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  // Move focus into the drawer when it opens.
  useEffect(() => {
    if (isOpen) panelRef.current?.querySelector("a")?.focus();
  }, [isOpen]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls="primary-menu"
        aria-label="Menu"
        className="inline-flex items-center gap-2 rounded-lg border border-on-shell/50 px-3 py-2 text-sm font-medium text-on-shell transition hover:bg-on-shell/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-shell"
      >
        <span aria-hidden="true" className="flex flex-col gap-[3px]">
          <span className="block h-[2px] w-4 bg-on-shell" />
          <span className="block h-[2px] w-4 bg-on-shell" />
          <span className="block h-[2px] w-4 bg-on-shell" />
        </span>
        Menu
      </button>

      {isOpen ? (
        <>
          {/* Clicking away closes it. Hidden from assistive tech: Escape and the
              menu button already do this, so it would only be noise. */}
          <div
            aria-hidden="true"
            onClick={() => setIsOpen(false)}
            className="fixed inset-0 z-40 bg-shell/60"
          />
          <div
            id="primary-menu"
            ref={panelRef}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,85vw)] flex-col gap-1 overflow-y-auto border-r border-on-shell/20 bg-shell p-4 text-on-shell shadow-xl"
          >
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-on-shell">TwinBank</p>
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  buttonRef.current?.focus();
                }}
                aria-label="Close menu"
                className="rounded-md border border-on-shell/50 px-2 py-1 text-xs text-on-shell/80 transition hover:bg-on-shell/10 hover:text-on-shell focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-shell"
              >
                Close
              </button>
            </div>
            <nav aria-label="Primary">
              <ul className="flex flex-col gap-1">
                {DESTINATIONS.map((destination) => {
                  const current = isCurrent(pathname, destination.href);
                  return (
                    <li key={destination.href}>
                      <Link
                        href={destination.href}
                        onClick={() => setIsOpen(false)}
                        aria-current={current ? "page" : undefined}
                        className={`block rounded-lg border px-3 py-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-shell ${
                          current
                            ? "border-on-shell/70 bg-on-shell/10 text-on-shell"
                            : "border-transparent text-on-shell/80 hover:bg-on-shell/10 hover:text-on-shell"
                        }`}
                      >
                        <span className="block text-sm font-medium">
                          {destination.label}
                          {/* Not colour alone: the current page says so in text. */}
                          {current ? (
                            <span className="ml-2 text-[11px] font-normal text-on-shell">
                              Current page
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-xs text-on-shell/70">
                          {destination.purpose}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>
        </>
      ) : null}
    </>
  );
}
