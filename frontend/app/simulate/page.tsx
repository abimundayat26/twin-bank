"use client";

/**
 * Purchase Simulator (SPEC section 9.4).
 *
 * The form is the whole question and the comparison is the whole answer, in
 * that order down the page. There is no explanation paragraph, no drivers list
 * and no assumptions block: the backend still returns them, and this page
 * deliberately does not show them (SM-6). It also never reduces the result to a
 * single "can afford" verdict — the Impact badge carries a level and the
 * reasons behind it, and both come from the backend (SM-5, G-6).
 */

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { AlternativesPanel } from "@/components/AlternativesPanel";
import { CommitActions } from "@/components/CommitActions";
import { PurchaseSimulator } from "@/components/PurchaseSimulator";
import { ScenarioComparison } from "@/components/ScenarioComparison";
import { TrajectoryPreview } from "@/components/TrajectoryPreview";
import { Card } from "@/components/ui";
import { alternativeRows } from "@/lib/alternatives";
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
    isOffline,
    simulation,
    simulationSource,
    isSimulating,
    simulationError,
    optimization,
    isOptimizing,
    optimizationError,
    planChanged,
    commitResult,
    isCommitting,
    commitError,
    simulate,
    optimize,
    commit,
    earliestDate,
  } = useTwin();

  // Alternatives belong with a successful result, so they are asked for as soon
  // as there is one rather than hidden behind a button. It runs a Monte Carlo
  // per option, so it is left to arrive on its own: the comparison renders
  // immediately and the panel shows its own waiting state.
  const simulationId = simulation?.simulation_id;
  useEffect(() => {
    // The saved offline example is not the reader's purchase, so there is
    // nothing honest to optimize against it.
    if (!simulationId || simulationSource !== "api") return;
    if (optimization || isOptimizing || optimizationError) return;
    void optimize();
    // `optimize` is stable for a given simulation; the id is what should retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationId, simulationSource]);

  if (twinError) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-10">
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
      <main className="mx-auto w-full max-w-5xl px-6 py-10">
        <p className="text-sm text-muted">Loading the Financial Twin…</p>
      </main>
    );
  }

  const goal = primaryGoal(twin);
  const reserve = emergencyReserve(twin);
  const purchase = simulation?.request.events[0];
  // The same rows the table shows, so Apply Compromise can only ever commit the
  // option the reader is looking at (SM-11, SM-12).
  const compromise =
    optimization && simulation
      ? alternativeRows(optimization, simulation.counterfactual).find((r) => r.key === "compromise")
      : undefined;

  return (
    <main className="mx-auto grid w-full max-w-5xl gap-4 px-6 py-8">
      <div>
        <h1 className="text-lg font-semibold text-ink">Purchase Simulator</h1>
        <p className="text-sm text-muted">
          Compare the future without the purchase against the future with it. TwinBank shows
          the tradeoffs; the decision stays yours.
        </p>
      </div>

      <PurchaseSimulator
        twin={twin}
        lastDate={goal?.deadline}
        isSimulating={isSimulating}
        prefill={prefill}
        isOffline={isOffline}
        error={simulationError}
        onSimulate={simulate}
      />

      {/* G-14: a failed run shows its message in the form and no numbers at
          all. `simulation` is already cleared by the provider on an error. */}
      {simulation ? (
        <>
          <ScenarioComparison twin={twin} simulation={simulation} />

          <TrajectoryPreview
            bands={simulation.balance_bands}
            asOf={twin.as_of}
            horizonEnd={simulation.horizon_end}
            reserve={reserve?.amount}
            simulations={simulation.num_simulations}
            markers={[
              ...(purchase
                ? [{ date: purchase.date, label: purchase.description, tone: "counter" as const }]
                : []),
              ...(goal ? [{ date: goal.deadline, label: goal.name, tone: "faint" as const }] : []),
            ]}
          />

          {simulationSource === "api" ? (
            optimization ? (
              <AlternativesPanel
                optimization={optimization}
                purchaseMetrics={simulation.counterfactual}
              />
            ) : (
              <Card title="Other ways to do this">
                {optimizationError ? (
                  <>
                    {/* E-6: a failed optimization never hides the comparison. */}
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

          <CommitActions
            twin={twin}
            simulation={simulation}
            goal={goal}
            compromise={compromise}
            isOffline={isOffline}
            isCommitting={isCommitting}
            planChanged={planChanged}
            commitResult={commitResult}
            commitError={commitError}
            onCommit={commit}
            onEarliestDate={earliestDate}
          />
        </>
      ) : (
        <Card>
          <p className="text-sm text-muted">
            Press <span className="text-counter">Simulate</span> to compare the future without
            the purchase against the future with it.
          </p>
        </Card>
      )}
    </main>
  );
}
