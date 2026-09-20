"use client";

/**
 * Purchase Simulator: the focused workspace for one counterfactual purchase.
 *
 * It answers how the purchase moves the ending balance, what it does to
 * low-balance and reserve risk, whether the goal still lands, and what the
 * lower-impact alternatives are. It deliberately does not reduce any of that to
 * a single "can afford" verdict (SPEC section 3.3).
 *
 * The detailed time series lives on Balance Trajectory; this page links to it
 * once there is something to look at.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { AlternativesPanel } from "@/components/AlternativesPanel";
import { ExplanationPanel } from "@/components/ExplanationPanel";
import { PurchaseSimulator } from "@/components/PurchaseSimulator";
import { ScenarioComparison } from "@/components/ScenarioComparison";
import { Card } from "@/components/ui";
import { readPrefillParams } from "@/lib/assistant";
import { useTwin } from "@/lib/state/TwinProvider";
import { emergencyReserve, primaryGoal } from "@/lib/twin";

/**
 * `useSearchParams` makes everything under it client-rendered, so the Suspense
 * boundary is here rather than around the whole route (Next.js: useSearchParams,
 * "Prerendering"). The workspace below is what the page has always been.
 */
export default function SimulatePage() {
  return (
    <Suspense fallback={<p className="px-6 py-10 text-sm text-muted">Loading the Simulator…</p>}>
      <SimulateWorkspace />
    </Suspense>
  );
}

function SimulateWorkspace() {
  // A what-if the Assistant routed here fills the form; it never runs it (PL-6).
  const prefill = readPrefillParams(useSearchParams());
  const {
    twin,
    twinError,
    simulation,
    simulationSource,
    isSimulating,
    simulationError,
    optimization,
    isOptimizing,
    optimizationError,
    simulate,
    optimize,
  } = useTwin();

  // Alternatives belong with a successful result (SPEC §3.3), so they are asked
  // for as soon as there is one rather than hidden behind a button. It runs a
  // Monte Carlo per option, so it is left to arrive on its own: the comparison
  // above renders immediately and the panel shows its own waiting state.
  const simulationId = simulation?.simulation_id;
  useEffect(() => {
    // The saved offline example is not Alex's purchase, so there is nothing
    // honest to optimize against it.
    if (!simulationId || simulationSource !== "api") return;
    if (optimization || isOptimizing || optimizationError) return;
    void optimize();
    // `optimize` is stable for a given simulation; the id is what should retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationId, simulationSource]);

  if (twinError) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <Card title="Could not load the Financial Twin">
          <p className="text-sm text-bad">{twinError}</p>
          <p className="mt-3 text-sm text-muted">
            A simulation needs the twin it is projecting from, so there is nothing to
            simulate until the backend answers.
          </p>
        </Card>
      </main>
    );
  }

  if (!twin) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <p className="text-sm text-muted">Loading Alex&rsquo;s Financial Twin…</p>
      </main>
    );
  }

  const goal = primaryGoal(twin);
  const reserve = emergencyReserve(twin);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-ink">Purchase Simulator</h1>
        <p className="text-sm text-muted">
          Compare the future without the purchase against the future with it. TwinBank shows
          the tradeoffs; the decision stays yours.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[360px_1fr] lg:items-start">
        <PurchaseSimulator
          twin={twin}
          lastDate={goal?.deadline}
          isSimulating={isSimulating}
          prefill={prefill}
          onSimulate={simulate}
        />

        <div className="grid gap-4">
          {simulationError ? (
            <Card title="Simulation failed">
              <p className="text-sm text-bad">{simulationError}</p>
            </Card>
          ) : null}

          {simulation ? (
            <>
              {simulationSource === "fixture" ? (
                <Card title="Backend offline">
                  <p className="text-sm text-caution">
                    Showing the saved example ($800 laptop). Your purchase and answers are
                    not applied until the backend is running.
                  </p>
                </Card>
              ) : null}

              <ScenarioComparison simulation={simulation} reserve={reserve} goal={goal} />
              <ExplanationPanel simulation={simulation} />

              <Card title="The detail behind these numbers">
                <p className="text-sm text-muted">
                  The full projection, its uncertainty bands, the purchase marker and the
                  reserve line are on the Balance Trajectory page.
                </p>
                <Link
                  href="/trajectory"
                  className="mt-3 inline-block rounded-lg border border-counter px-4 py-2.5 text-sm font-semibold text-counter transition hover:bg-counter/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter"
                >
                  See the balance trajectory
                </Link>
              </Card>

              {simulationSource === "api" ? (
                optimization ? (
                  <AlternativesPanel
                    optimization={optimization}
                    reserve={reserve}
                    goal={goal}
                  />
                ) : (
                  <Card title="Other ways to do this">
                    {optimizationError ? (
                      <>
                        <p className="text-sm text-bad">
                          Could not compare options: {optimizationError}
                        </p>
                        <button
                          type="button"
                          onClick={() => void optimize()}
                          disabled={isOptimizing}
                          className="mt-3 rounded-lg border border-line px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isOptimizing ? "Comparing options…" : "Try again"}
                        </button>
                      </>
                    ) : (
                      <p className="text-sm text-muted">Comparing other ways to do this…</p>
                    )}
                  </Card>
                )
              ) : null}
            </>
          ) : (
            <Card>
              <p className="text-sm text-muted">
                Press <span className="text-counter">Simulate</span> to compare the future
                without the purchase against the future with it.
              </p>
            </Card>
          )}
        </div>
      </div>
    </main>
  );
}
