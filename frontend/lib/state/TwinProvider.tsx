"use client";

/**
 * The twin, the latest simulation, and every call to `lib/api`, in one place.
 *
 * This used to live in the single page component. It moved here so the state
 * survives navigation between routes: SPEC section 9 requires the current twin
 * and the latest simulation to be preserved while the user changes pages, and a
 * page-owned `useState` is discarded on every route change.
 *
 * The invalidation rules live here too, because they are what keeps the screen
 * honest and no page should be able to skip them:
 *
 * * a twin update clears the simulation built on the previous twin,
 * * a new simulation clears the alternatives that belonged to the old one,
 * * an older in-flight response never overwrites a newer one.
 *
 * Pages read this through `useTwin()`. Components below them stay
 * presentational and keep receiving contract types as props.
 */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
import { GOALS_SCOPE, MINIMUM_BALANCE_SCOPE } from "@/lib/scopes";
import type {
  DeclaredGoalsRequest,
  FinancialTwin,
  GoalCompileResponse,
  ObligationCategory,
  OptimizationResponse,
  SimulationEvent,
  SimulationResponse,
} from "@/lib/types";

export const DEMO_USER_ID = "alex";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TwinState {
  twin: FinancialTwin | null;
  source: DataSource | undefined;
  twinError: string | undefined;
  isBusy: boolean;
  savingScope: string | undefined;
  twinUpdateError: string | undefined;

  goalDraft: GoalCompileResponse | null;
  isCompilingGoal: boolean;
  goalCompileError: string | undefined;
  goalSaveError: string | undefined;
  composerKey: number;

  simulation: SimulationResponse | null;
  simulationSource: DataSource | undefined;
  isSimulating: boolean;
  simulationError: string | undefined;

  optimization: OptimizationResponse | null;
  isOptimizing: boolean;
  optimizationError: string | undefined;

  answerClarification: (obligationId: string, category: ObligationCategory) => void;
  setMinimum: (amount: number) => void;
  compileGoalText: (text: string) => Promise<void>;
  confirmGoals: (request: DeclaredGoalsRequest) => Promise<void>;
  removeGoal: (goalId: string) => void;
  discardGoalDraft: () => void;
  simulate: (event: SimulationEvent) => Promise<void>;
  optimize: () => Promise<void>;
}

const TwinContext = createContext<TwinState | null>(null);

export function TwinProvider({ children }: { children: ReactNode }) {
  const [twin, setTwin] = useState<FinancialTwin | null>(null);
  const [source, setSource] = useState<DataSource>();
  const [twinError, setTwinError] = useState<string>();
  // Two things, kept apart: whether a twin update is in flight at all (no second
  // one may start), and which control began it (only that one says "Saving…").
  const [isBusy, setIsBusy] = useState(false);
  const [savingScope, setSavingScope] = useState<string>();
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
   * `scope` names the control that started it — a goal's id, an obligation's id,
   * or one of the exported scope constants — so the waiting state shows up there
   * and nowhere else. Returns whether the twin was saved, and reports a failure
   * wherever the caller asks, so an error lands next to the control that caused it.
   */
  async function updateTwin(
    update: Promise<Loaded<FinancialTwin>>,
    scope: string,
    reportError: (message?: string) => void = setTwinUpdateError,
  ): Promise<boolean> {
    latestRequest.current += 1;
    setIsBusy(true);
    setSavingScope(scope);
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
      setIsBusy(false);
      setSavingScope(undefined);
    }
  }

  function answerClarification(obligationId: string, category: ObligationCategory) {
    if (!twin) return;
    void updateTwin(
      respondToClarification(twin, {
        user_id: twin.user_id,
        obligation_id: obligationId,
        category,
      }),
      obligationId,
    );
  }

  function setMinimum(amount: number) {
    if (!twin) return;
    void updateTwin(setMinimumBalance(twin, { amount }), MINIMUM_BALANCE_SCOPE);
  }

  /** Drafts only. Nothing reaches the twin until `confirmGoals`. */
  async function compileGoalText(text: string) {
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
  async function confirmGoals(request: DeclaredGoalsRequest) {
    if (!twin) return;
    if (await updateTwin(saveGoals(twin, request), GOALS_SCOPE, setGoalSaveError)) {
      setGoalDraft(null);
      setComposerKey((key) => key + 1);
    }
  }

  function removeGoal(goalId: string) {
    if (!twin) return;
    void updateTwin(saveGoals(twin, withoutGoal(twin, goalId)), goalId);
  }

  function discardGoalDraft() {
    setGoalDraft(null);
    setGoalSaveError(undefined);
  }

  async function simulate(event: SimulationEvent) {
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
  async function optimize() {
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

  const value: TwinState = {
    twin,
    source,
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
  };

  return <TwinContext.Provider value={value}>{children}</TwinContext.Provider>;
}

/** Throws outside the provider rather than handing back a silently empty twin. */
export function useTwin(): TwinState {
  const value = useContext(TwinContext);
  if (!value) throw new Error("useTwin must be used inside a TwinProvider");
  return value;
}
