"use client";

/**
 * Balance Trajectory: the projection behind the latest simulation (SPEC 9.5).
 *
 * The simulation lives in the provider, so arriving here from the simulator
 * shows the same result rather than re-running it. A reload empties the
 * provider, so the page keeps the `simulation_id` in `sessionStorage` and asks
 * `GET /explain/{id}` for it again (TR-1). The backend holds results in memory,
 * so an id from before a restart is a 404 — that is the empty state, not an
 * error, because there is genuinely nothing to show any more.
 *
 * The refetched result is held here rather than pushed into the provider: the
 * provider owns what the simulator produced, and this page only needs something
 * to draw. Nothing here computes a figure (G-6).
 */

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BalanceTrajectoryChart } from "@/components/BalanceTrajectoryChart";
import { Card } from "@/components/ui";
import { ApiError, getExplanation, type DataSource } from "@/lib/api";
import { useTwin } from "@/lib/state/TwinProvider";
import { emergencyReserve, primaryGoal } from "@/lib/twin";
import { DEFAULT_LOW_BALANCE_THRESHOLD, type SimulationResponse } from "@/lib/types";

/** Where the id of the simulation on screen survives a reload (TR-1). */
export const SIMULATION_ID_KEY = "twinbank.simulation_id";

/** `sessionStorage` throws in a sandboxed frame and is absent while rendering on the server. */
function readStoredId(): string | null {
  try {
    return window.sessionStorage.getItem(SIMULATION_ID_KEY);
  } catch {
    return null;
  }
}

/**
 * The page writes this key as well as reading it, so the reads subscribe.
 *
 * Clearing the id is how a discarded simulation stops being restorable, and the
 * render below decides what to show from the subscribed value. Without the
 * notification that value would stay stale for the rest of the mount, and the
 * page would go on offering a result the app has just thrown away.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function announce(): void {
  listeners.forEach((onChange) => onChange());
}

function storeId(simulationId: string): void {
  try {
    window.sessionStorage.setItem(SIMULATION_ID_KEY, simulationId);
  } catch {
    // A session that cannot remember the id simply shows the empty state on
    // reload. It is a convenience, not a requirement.
  }
  announce();
}

/** The stored id names a result that is no longer valid, so it must not outlive it. */
function forgetId(): void {
  try {
    window.sessionStorage.removeItem(SIMULATION_ID_KEY);
  } catch {
    // Same as `storeId`: nothing can be restored without a readable id anyway.
  }
  announce();
}

export default function TrajectoryPage() {
  const { twin, simulation, simulationSource } = useTwin();

  const storedId = useSyncExternalStore(subscribe, readStoredId, () => null);

  /** The result recovered from a previous session, when the provider has none. */
  const [restored, setRestored] = useState<SimulationResponse | null>(null);
  const [restoredSource, setRestoredSource] = useState<DataSource>();
  const [restoreError, setRestoreError] = useState<string>();
  /** The refetch has come back, whether with a result, a 404 or an error. */
  const [settled, setSettled] = useState(false);
  const [attempt, setAttempt] = useState(0);

  /**
   * Whether this mount has ever held a live simulation.
   *
   * The difference between "nothing has been run" and "what was run is no longer
   * valid" cannot be read from the provider's `simulation` being null, because it
   * is null in both cases. The provider drops it on a twin update, on an applied
   * twin, and on a failed run — and the stored id outlives all three. Without
   * this, the restore below would undo a deliberate discard and redraw a
   * projection the app has already rejected: against a twin it was not computed
   * from, or, after a failed run, in place of the error G-9 and G-14 require.
   *
   * A ref rather than state, and read only inside the effect below: it must not
   * cause a render, `react-hooks/set-state-in-effect` forbids setting state in an
   * effect body, and `react-hooks/refs` forbids reading a ref while rendering.
   * What render sees is the stored id, which this effect clears on a discard.
   */
  const hasHadLive = useRef(false);

  // The provider's simulation is the live one, so its id is what a reload
  // should recover. When it goes away, so must the id.
  useEffect(() => {
    if (simulation) {
      hasHadLive.current = true;
      storeId(simulation.simulation_id);
    } else if (hasHadLive.current) {
      forgetId();
    }
  }, [simulation]);

  useEffect(() => {
    // Restoring is for a cold load and nothing else.
    if (simulation || !storedId || hasHadLive.current) return;

    let current = true;
    getExplanation(storedId)
      .then(({ data, source }) => {
        if (!current) return;
        setRestored(data);
        setRestoredSource(source);
      })
      .catch((error: unknown) => {
        if (!current) return;
        // Gone from the backend's memory: there is nothing to show, which is the
        // empty state. Any other failure is reported verbatim (G-9).
        if (error instanceof ApiError && error.status === 404) {
          setRestored(null);
        } else {
          setRestoreError(error instanceof Error ? error.message : "Could not load the projection.");
        }
      })
      .finally(() => {
        if (current) setSettled(true);
      });

    return () => {
      current = false;
    };
  }, [simulation, storedId, attempt]);

  // No stored id means nothing here is restorable, which is what a discard
  // leaves behind. It also keeps a result restored on a cold load from standing
  // in for a later run that failed: the same stale projection by another route.
  const shown = simulation ?? (storedId ? restored : null);
  const shownSource = simulation ? simulationSource : restoredSource;
  const isRestoring = Boolean(storedId) && !simulation && !settled;

  if (isRestoring && !shown) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        {/* G-7: a skeleton the size of the chart, so nothing jumps when it lands. */}
        <Card title="Balance trajectory">
          <div className="h-[260px] animate-pulse rounded-lg bg-raised" aria-hidden="true" />
          <p className="sr-only">Loading the projection.</p>
        </Card>
      </main>
    );
  }

  // Same reasoning: a failed refetch has nothing to say about an id the page is
  // no longer willing to restore.
  if (restoreError && !shown && storedId) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <Card title="Balance trajectory">
          <p className="text-sm text-bad">{restoreError}</p>
          <button
            type="button"
            onClick={() => {
              setRestoreError(undefined);
              setSettled(false);
              setAttempt((count) => count + 1);
            }}
            className="mt-3 rounded-lg border border-line px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-baseline"
          >
            Retry
          </button>
        </Card>
      </main>
    );
  }

  if (!shown || !twin) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <Card title="No projection yet">
          <p className="text-sm text-muted">
            This page shows the balance bands behind a simulation: the baseline future, the
            future with the purchase, the purchase marker, the goal deadline and the reserve
            and low-balance reference lines.
          </p>
          <p className="mt-3 text-sm text-muted">
            Run a purchase first and the projection will appear here.
          </p>
          <Link
            href="/simulate"
            className="mt-3 inline-block rounded-lg border border-counter px-4 py-2.5 text-sm font-semibold text-counter transition hover:bg-counter/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter"
          >
            Go to the Purchase Simulator
          </Link>
        </Card>
      </main>
    );
  }

  const goal = primaryGoal(twin);
  const reserve = emergencyReserve(twin);
  const minimum = twin.constraints.find((c) => c.type === "minimum_checking_balance");
  const purchases = shown.request.events;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Balance Trajectory</h1>
          <p className="text-sm text-muted">The projection behind the latest simulation.</p>
        </div>
        <Link
          href="/simulate"
          className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-baseline"
        >
          Change the purchase
        </Link>
      </div>

      {shownSource === "fixture" ? (
        <div className="mb-4">
          <Card title="Backend offline">
            <p className="text-sm text-caution">
              This is the saved example ($800 laptop), not your purchase. Your entries and
              answers are not applied until the backend is running.
            </p>
          </Card>
        </div>
      ) : null}

      {/* G-13: say when the figures are a sample, and never that they are live. */}
      {shown.is_mock ? (
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-caution">
          Sample figures
        </p>
      ) : null}

      <BalanceTrajectoryChart
        bands={shown.balance_bands}
        asOf={twin.as_of}
        reserve={reserve?.amount}
        checkingMinimum={minimum?.amount ?? DEFAULT_LOW_BALANCE_THRESHOLD}
        checkingMinimumIsDefault={!minimum}
        simulations={shown.num_simulations}
        markers={[
          ...purchases.map((event) => ({
            date: event.date,
            label: event.description,
            tone: "counter" as const,
          })),
          ...(goal ? [{ date: goal.deadline, label: goal.name, tone: "faint" as const }] : []),
        ]}
      />
    </main>
  );
}
