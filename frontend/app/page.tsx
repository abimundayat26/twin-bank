"use client";

/**
 * The single TwinBank demo screen.
 *
 * State and every call to `lib/api` live in `TwinProvider`, so they survive a
 * route change. This page reads them through `useTwin()` and stays as
 * presentational as the components below it, which still receive contract types
 * as props.
 */

import { AlternativesPanel } from "@/components/AlternativesPanel";
import { BalanceTrajectoryChart } from "@/components/BalanceTrajectoryChart";
import { ExplanationPanel } from "@/components/ExplanationPanel";
import { FinancialSummary } from "@/components/FinancialSummary";
import { GoalCard } from "@/components/GoalCard";
import { GoalComposer } from "@/components/GoalComposer";
import { IntentGraph } from "@/components/IntentGraph";
import { PurchaseSimulator } from "@/components/PurchaseSimulator";
import { ScenarioComparison } from "@/components/ScenarioComparison";
import { Card } from "@/components/ui";
import { useTwin } from "@/lib/state/TwinProvider";
import type { Goal } from "@/lib/types";

/**
 * Soonest deadline first. The backend's default horizon ends at the earliest
 * goal deadline, so the first of these is the one that sets it.
 */
function byDeadline(goals: Goal[]): Goal[] {
  return [...goals].sort((a, b) => a.deadline.localeCompare(b.deadline));
}

export default function Home() {
  const {
    twin,
    twinError,
    isBusy,
    savingScope,
    twinUpdateError,
    goalDraft,
    isCompilingGoal,
    goalCompileError,
    goalSaveError,
    composerKey,
    simulation,
    simulationSource,
    isSimulating,
    simulationError,
    optimization,
    isOptimizing,
    optimizationError,
    answerClarification,
    setMinimum,
    compileGoalText,
    confirmGoals,
    removeGoal,
    discardGoalDraft,
    simulate,
    optimize,
  } = useTwin();

  if (twinError) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <Card title="Could not load the Financial Twin">
          <p className="text-sm text-bad">{twinError}</p>
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

  const goals = byDeadline(twin.goals);
  const goal = goals[0];
  const reserve = twin.constraints.find((c) => c.type === "minimum_reserve");

  return (
    <>
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
              isBusy={isBusy}
              savingScope={savingScope}
              onAnswer={answerClarification}
              onSetMinimum={setMinimum}
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
                  isBusy={isBusy}
                  savingScope={savingScope}
                  onRemove={removeGoal}
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
              asOf={twin.as_of}
              draft={goalDraft}
              isCompiling={isCompilingGoal}
              isBusy={isBusy}
              savingScope={savingScope}
              compileError={goalCompileError}
              saveError={goalSaveError}
              onCompile={compileGoalText}
              onConfirm={confirmGoals}
              onDiscard={discardGoalDraft}
            />

            <PurchaseSimulator
              twin={twin}
              lastDate={goal?.deadline}
              isSimulating={isSimulating}
              onSimulate={simulate}
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
                        onClick={optimize}
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
