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
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        buttonRef.current?.focus();
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
        className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink transition hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-baseline"
      >
        <span aria-hidden="true" className="flex flex-col gap-[3px]">
          <span className="block h-[2px] w-4 bg-ink" />
          <span className="block h-[2px] w-4 bg-ink" />
          <span className="block h-[2px] w-4 bg-ink" />
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
            className="fixed inset-0 z-40 bg-canvas/70"
          />
          <div
            id="primary-menu"
            ref={panelRef}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,85vw)] flex-col gap-1 overflow-y-auto border-r border-line bg-surface p-4 shadow-xl"
          >
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-ink">TwinBank</p>
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  buttonRef.current?.focus();
                }}
                aria-label="Close menu"
                className="rounded-md border border-line px-2 py-1 text-xs text-muted transition hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-baseline"
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
                        className={`block rounded-lg border px-3 py-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-baseline ${
                          current
                            ? "border-baseline/50 bg-raised text-ink"
                            : "border-transparent text-muted hover:bg-raised hover:text-ink"
                        }`}
                      >
                        <span className="block text-sm font-medium">
                          {destination.label}
                          {/* Not colour alone: the current page says so in text. */}
                          {current ? (
                            <span className="ml-2 text-[11px] font-normal text-baseline">
                              Current page
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-xs text-faint">
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
