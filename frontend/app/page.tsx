"use client";

/**
 * The single TwinBank demo screen.
 *
 * This is the only component that touches `lib/api`. Everything below it is
 * presentational and receives contract types as props, so swapping mocks for
 * the real backend changes nothing here.
 */

import { useEffect, useRef, useState } from "react";
import { AlternativesPanel } from "@/components/AlternativesPanel";
import { BalanceTrajectoryChart } from "@/components/BalanceTrajectoryChart";
import { ExplanationPanel } from "@/components/ExplanationPanel";
import { FinancialSummary } from "@/components/FinancialSummary";
import { GoalCard } from "@/components/GoalCard";
import { GoalComposer } from "@/components/GoalComposer";
import { Header } from "@/components/Header";
import { IntentGraph } from "@/components/IntentGraph";
import { PurchaseSimulator } from "@/components/PurchaseSimulator";
import { ScenarioComparison } from "@/components/ScenarioComparison";
import { Card } from "@/components/ui";
import {
  compileGoal,
  getTwin,
  respondToClarification,
  runOptimization,
  runSimulation,
  saveGoals,
  setMinimumBalance,
  type DataSource,
  type Loaded,
} from "@/lib/api";
import { withoutGoal } from "@/lib/goals";
import type {
  DeclaredGoalsRequest,
  FinancialTwin,
  Goal,
  GoalCompileResponse,
  ObligationCategory,
  OptimizationResponse,
  SimulationEvent,
  SimulationResponse,
} from "@/lib/types";

const DEMO_USER_ID = "alex";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Soonest deadline first. The backend's default horizon ends at the earliest
 * goal deadline, so the first of these is the one that sets it.
 */
function byDeadline(goals: Goal[]): Goal[] {
  return [...goals].sort((a, b) => a.deadline.localeCompare(b.deadline));
}

export default function Home() {
  const [twin, setTwin] = useState<FinancialTwin | null>(null);
  const [source, setSource] = useState<DataSource>();
  const [twinError, setTwinError] = useState<string>();
  const [isSavingTwin, setIsSavingTwin] = useState(false);
  const [twinUpdateError, setTwinUpdateError] = useState<string>();

  // Drafts from the goal compiler, waiting for Alex to confirm them. Kept here
  // because compiling is an API call; the composer itself only receives props.
  const [goalDraft, setGoalDraft] = useState<GoalCompileResponse | null>(null);
  const [isCompilingGoal, setIsCompilingGoal] = useState(false);
  const [goalCompileError, setGoalCompileError] = useState<string>();
  const [goalSaveError, setGoalSaveError] = useState<string>();
  // Bumped after a confirmed save, to remount the composer with an empty box.
  const [composerKey, setComposerKey] = useState(0);

  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [simulationSource, setSimulationSource] = useState<DataSource>();
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationError, setSimulationError] = useState<string>();
  // Bumped by every simulation and twin update; only the latest simulation may render.
  const latestRequest = useRef(0);

  // Alternatives belong to the simulation on screen and are cleared with it.
  const [optimization, setOptimization] = useState<OptimizationResponse | null>(null);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizationError, setOptimizationError] = useState<string>();

  function clearOptimization() {
    setOptimization(null);
    setOptimizationError(undefined);
  }

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

  /**
   * Alex changed a declared fact, so any earlier simulation is now stale. A new
   * goal can also move the default horizon, which is why clearing is not optional.
   *
   * Returns whether the twin was saved, and reports a failure wherever the caller
   * asks, so an error lands next to the control that caused it.
   */
  async function updateTwin(
    update: Promise<Loaded<FinancialTwin>>,
    reportError: (message?: string) => void = setTwinUpdateError,
  ): Promise<boolean> {
    latestRequest.current += 1;
    setIsSavingTwin(true);
    reportError(undefined);
    try {
      const loaded = await update;
      setTwin(loaded.data);
      setSource(loaded.source);
      setSimulation(null);
      setSimulationError(undefined);
      clearOptimization();
      return true;
    } catch (error: unknown) {
      reportError(errorText(error));
      return false;
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

  /** Drafts only. Nothing reaches the twin until `handleConfirmGoals`. */
  async function handleCompileGoal(text: string) {
    if (!twin) return;
    setIsCompilingGoal(true);
    setGoalCompileError(undefined);
    setGoalSaveError(undefined);
    try {
      const loaded = await compileGoal({ user_id: twin.user_id, text });
      setGoalDraft(loaded.data);
    } catch (error: unknown) {
      // No fixture behind `compileGoal`: there is nothing honest to show instead.
      setGoalDraft(null);
      setGoalCompileError(errorText(error));
    } finally {
      setIsCompilingGoal(false);
    }
  }

  /**
   * `request` is the complete declared set the composer merged, not just the new
   * goal: the endpoint replaces everything it is sent. A rejected save keeps the
   * draft on screen so Alex can fix the text rather than retype it.
   */
  async function handleConfirmGoals(request: DeclaredGoalsRequest) {
    if (!twin) return;
    if (await updateTwin(saveGoals(twin, request), setGoalSaveError)) {
      setGoalDraft(null);
      setComposerKey((key) => key + 1);
    }
  }

  function handleRemoveGoal(goalId: string) {
    if (!twin) return;
    void updateTwin(saveGoals(twin, withoutGoal(twin, goalId)));
  }

  async function handleSimulate(event: SimulationEvent) {
    if (!twin) return;
    const request = ++latestRequest.current;
    setIsSimulating(true);
    setSimulationError(undefined);
    clearOptimization();
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

  /** On demand: /optimize runs a Monte Carlo per option, so Simulate stays fast. */
  async function handleOptimize() {
    if (!simulation) return;
    const request = latestRequest.current;
    setIsOptimizing(true);
    setOptimizationError(undefined);
    try {
      const loaded = await runOptimization({
        user_id: simulation.user_id,
        events: simulation.request.events,
        horizon_end: simulation.request.horizon_end,
      });
      if (request !== latestRequest.current) return;
      setOptimization(loaded.data);
    } catch (error: unknown) {
      if (request !== latestRequest.current) return;
      setOptimizationError(errorText(error));
    } finally {
      setIsOptimizing(false);
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

  const goals = byDeadline(twin.goals);
  const goal = goals[0];
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
            {goals.length > 0 ? (
              goals.map((each, index) => (
                <GoalCard
                  key={each.id}
                  goal={each}
                  title={index === 0 ? "Active savings goal" : "Also saving for"}
                  subtitle={
                    index === 0 && goals.length > 1
                      ? "The soonest deadline, which is where the simulation ends."
                      : undefined
                  }
                  isSaving={isSavingTwin}
                  onRemove={handleRemoveGoal}
                />
              ))
            ) : (
              <Card title="Savings goals">
                <p className="text-sm text-muted">
                  No goals declared. The simulation looks 180 days ahead.
                </p>
              </Card>
            )}

            <GoalComposer
              key={composerKey}
              goals={twin.goals}
              constraints={twin.constraints}
              draft={goalDraft}
              isCompiling={isCompilingGoal}
              isSaving={isSavingTwin}
              compileError={goalCompileError}
              saveError={goalSaveError}
              onCompile={handleCompileGoal}
              onConfirm={handleConfirmGoals}
              onDiscard={() => {
                setGoalDraft(null);
                setGoalSaveError(undefined);
              }}
            />

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
                {/* The saved example is not Alex's purchase, so there is nothing to optimize offline. */}
                {simulationSource === "api" ? (
                  optimization ? (
                    <AlternativesPanel optimization={optimization} reserve={reserve} goal={goal} />
                  ) : (
                    <Card>
                      <button
                        type="button"
                        onClick={handleOptimize}
                        disabled={isOptimizing}
                        className="w-full rounded-lg border border-counter px-4 py-2.5 text-sm font-semibold text-counter transition hover:bg-counter/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isOptimizing ? "Comparing options…" : "Compare other ways to do this"}
                      </button>
                      {optimizationError ? (
                        <p className="mt-3 text-sm text-bad">
                          Could not compare options: {optimizationError}
                        </p>
                      ) : null}
                    </Card>
                  )
                ) : null}
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
