"use client";

/**
 * The single TwinBank demo screen.
 *
 * This is the only component that touches `lib/api`. Everything below it is
 * presentational and receives contract types as props, so swapping mocks for
 * the real backend changes nothing here.
 */

import { useEffect, useRef, useState } from "react";
import { BalanceTrajectoryChart } from "@/components/BalanceTrajectoryChart";
import { ExplanationPanel } from "@/components/ExplanationPanel";
import { FinancialSummary } from "@/components/FinancialSummary";
import { GoalCard } from "@/components/GoalCard";
import { Header } from "@/components/Header";
import { IntentGraph } from "@/components/IntentGraph";
import { PurchaseSimulator } from "@/components/PurchaseSimulator";
import { ScenarioComparison } from "@/components/ScenarioComparison";
import { Card } from "@/components/ui";
import {
  getTwin,
  respondToClarification,
  runSimulation,
  setMinimumBalance,
  type DataSource,
  type Loaded,
} from "@/lib/api";
import type {
  FinancialTwin,
  Goal,
  ObligationCategory,
  SimulationEvent,
  SimulationResponse,
} from "@/lib/types";

const DEMO_USER_ID = "alex";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The backend's default horizon ends at the earliest goal deadline; match it. */
function earliestGoal(goals: Goal[]): Goal | undefined {
  return [...goals].sort((a, b) => a.deadline.localeCompare(b.deadline))[0];
}

export default function Home() {
  const [twin, setTwin] = useState<FinancialTwin | null>(null);
  const [source, setSource] = useState<DataSource>();
  const [twinError, setTwinError] = useState<string>();
  const [isSavingTwin, setIsSavingTwin] = useState(false);
  const [twinUpdateError, setTwinUpdateError] = useState<string>();

  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [simulationSource, setSimulationSource] = useState<DataSource>();
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationError, setSimulationError] = useState<string>();
  // Bumped by every simulation and twin update; only the latest simulation may render.
  const latestRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getTwin(DEMO_USER_ID)
      .then((loaded) => {
        if (cancelled) return;
        setTwin(loaded.data);
        setSource(loaded.source);
      })
      .catch((error: unknown) => {
        if (!cancelled) setTwinError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Alex changed a declared fact, so any earlier simulation is now stale. */
  async function updateTwin(update: Promise<Loaded<FinancialTwin>>) {
    latestRequest.current += 1;
    setIsSavingTwin(true);
    setTwinUpdateError(undefined);
    try {
      const loaded = await update;
      setTwin(loaded.data);
      setSource(loaded.source);
      setSimulation(null);
      setSimulationError(undefined);
    } catch (error: unknown) {
      setTwinUpdateError(errorText(error));
    } finally {
      setIsSavingTwin(false);
    }
  }

  function handleAnswer(obligationId: string, category: ObligationCategory) {
    if (!twin) return;
    void updateTwin(
      respondToClarification(twin, {
        user_id: twin.user_id,
        obligation_id: obligationId,
        category,
      }),
    );
  }

  function handleSetMinimum(amount: number) {
    if (!twin) return;
    void updateTwin(setMinimumBalance(twin, { amount }));
  }

  async function handleSimulate(event: SimulationEvent) {
    if (!twin) return;
    const request = ++latestRequest.current;
    setIsSimulating(true);
    setSimulationError(undefined);
    try {
      // No horizon_end: the backend defaults to the earliest goal deadline.
      const loaded = await runSimulation({ user_id: twin.user_id, events: [event] });
      if (request !== latestRequest.current) return;
      setSimulation(loaded.data);
      setSimulationSource(loaded.source);
    } catch (error: unknown) {
      if (request !== latestRequest.current) return;
      setSimulation(null);
      setSimulationError(errorText(error));
    } finally {
      setIsSimulating(false);
    }
  }

  if (twinError) {
    return (
      <>
        <Header />
        <main className="mx-auto w-full max-w-6xl px-6 py-10">
          <Card title="Could not load the Financial Twin">
            <p className="text-sm text-bad">{twinError}</p>
          </Card>
        </main>
      </>
    );
  }

  if (!twin) {
    return (
      <>
        <Header />
        <main className="mx-auto w-full max-w-6xl px-6 py-10">
          <p className="text-sm text-muted">Loading Alex&rsquo;s Financial Twin…</p>
        </main>
      </>
    );
  }

  const goal = earliestGoal(twin.goals);
  const reserve = twin.constraints.find((c) => c.type === "minimum_reserve");

  return (
    <>
      <Header userName={twin.display_name} source={source} isMock={simulation?.is_mock} />

      <main className="mx-auto w-full max-w-6xl px-6 py-8">
        {/* Full width and first: the structure of the money is what makes this
            more than a budgeting dashboard (SPEC §1). */}
        <div className="mb-6">
          <IntentGraph twin={twin} simulation={simulation} />
        </div>

        <div className="grid gap-6 lg:grid-cols-[360px_1fr] lg:items-start">
          <div className="grid gap-4">
            <div>
              <h1 className="text-lg font-semibold text-ink">
                {twin.display_name}&rsquo;s Financial Twin
              </h1>
              <p className="text-sm text-muted">
                What the bank observed, plus what {twin.display_name} declared.
              </p>
            </div>
            {twinUpdateError ? (
              <Card title="Could not save your answer">
                <p className="text-sm text-bad">{twinUpdateError}</p>
              </Card>
            ) : null}
            <FinancialSummary
              twin={twin}
              isSaving={isSavingTwin}
              onAnswer={handleAnswer}
              onSetMinimum={handleSetMinimum}
            />
          </div>

          <div className="grid gap-6">
            {goal ? <GoalCard goal={goal} /> : null}

            <PurchaseSimulator
              twin={twin}
              lastDate={goal?.deadline}
              isSimulating={isSimulating}
              onSimulate={handleSimulate}
            />

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
                {/* Above the table: the shape of the two futures, then the
                    numbers. `reserve` is the same constraint the table captions,
                    so the dashed line and the caption can never disagree. */}
                <BalanceTrajectoryChart
                  bands={simulation.balance_bands}
                  reserve={reserve?.amount}
                  simulations={simulation.num_simulations}
                  markers={[
                    ...simulation.request.events.map((event) => ({
                      date: event.date,
                      label: event.description,
                      tone: "counter" as const,
                    })),
                    ...(goal
                      ? [{ date: goal.deadline, label: goal.name, tone: "faint" as const }]
                      : []),
                  ]}
                />
                <ScenarioComparison
                  simulation={simulation}
                  reserve={reserve}
                  goal={goal}
                />
                <ExplanationPanel simulation={simulation} />
              </>
            ) : (
              <Card>
                <p className="text-sm text-muted">
                  Press <span className="text-counter">Simulate</span> to compare the
                  future without the purchase against the future with it.
                </p>
              </Card>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
