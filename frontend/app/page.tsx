"use client";

/**
 * The single TwinBank demo screen.
 *
 * This is the only component that touches `lib/api`. Everything below it is
 * presentational and receives contract types as props, so swapping mocks for
 * the real backend changes nothing here.
 */

import { useEffect, useState } from "react";
import { ExplanationPanel } from "@/components/ExplanationPanel";
import { FinancialSummary } from "@/components/FinancialSummary";
import { GoalCard } from "@/components/GoalCard";
import { Header } from "@/components/Header";
import { PurchaseSimulator } from "@/components/PurchaseSimulator";
import { ScenarioComparison } from "@/components/ScenarioComparison";
import { Card } from "@/components/ui";
import { getTwin, runSimulation, type DataSource } from "@/lib/api";
import type { FinancialTwin, SimulationEvent, SimulationResponse } from "@/lib/types";

const DEMO_USER_ID = "alex";

export default function Home() {
  const [twin, setTwin] = useState<FinancialTwin | null>(null);
  const [source, setSource] = useState<DataSource>();
  const [twinError, setTwinError] = useState<string>();

  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationError, setSimulationError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    getTwin(DEMO_USER_ID)
      .then((loaded) => {
        if (cancelled) return;
        setTwin(loaded.data);
        setSource(loaded.source);
      })
      .catch((error: unknown) => {
        if (!cancelled) setTwinError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSimulate(event: SimulationEvent) {
    if (!twin) return;
    setIsSimulating(true);
    setSimulationError(undefined);
    try {
      const loaded = await runSimulation({
        user_id: twin.user_id,
        events: [event],
        horizon_end: twin.goals[0]?.deadline ?? null,
      });
      setSimulation(loaded.data);
    } catch (error: unknown) {
      setSimulationError(String(error));
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

  const goal = twin.goals[0];
  const reserve = twin.constraints.find((c) => c.type === "minimum_reserve");

  return (
    <>
      <Header userName={twin.display_name} source={source} isMock={simulation?.is_mock} />

      <main className="mx-auto w-full max-w-6xl px-6 py-8">
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
            <FinancialSummary twin={twin} />
          </div>

          <div className="grid gap-6">
            {goal ? <GoalCard goal={goal} /> : null}

            <PurchaseSimulator
              twin={twin}
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
