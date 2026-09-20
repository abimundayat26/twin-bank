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
  ApiError,
  commitPurchase,
  findEarliestDate,
  getTwin,
  runOptimization,
  runSimulation,
  setMinimumBalance,
  type DataSource,
  type Loaded,
} from "@/lib/api";
import { OFFLINE_REASON } from "@/lib/offline";
import { MINIMUM_BALANCE_SCOPE } from "@/lib/scopes";
import type {
  EarliestDateResponse,
  FinancialTwin,
  GoalDateChange,
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
  isOffline: boolean;
  twinError: string | undefined;
  isBusy: boolean;
  savingScope: string | undefined;
  twinUpdateError: string | undefined;

  simulation: SimulationResponse | null;
  simulationSource: DataSource | undefined;
  isSimulating: boolean;
  simulationError: string | undefined;

  optimization: OptimizationResponse | null;
  isOptimizing: boolean;
  optimizationError: string | undefined;

  /**
   * A commit has changed the plan the comparison on screen was built from, so
   * the comparison is stale until it is run again (CM-6).
   */
  planChanged: boolean;
  commitResult: string | undefined;
  isCommitting: boolean;
  commitError: string | undefined;

  /** Replaces the twin with one the backend has already saved (see `applyTwin`). */
  applyTwin: (next: FinancialTwin) => void;
  /** Reloads the canonical twin after a stale 404/409 write. */
  refreshTwin: () => Promise<void>;
  setMinimum: (amount: number) => void;
  simulate: (event: SimulationEvent) => Promise<void>;
  optimize: () => Promise<void>;
  commit: (events: SimulationEvent[], goalUpdates?: GoalDateChange[]) => Promise<boolean>;
  earliestDate: (goalId: string, events: SimulationEvent[]) => Promise<EarliestDateResponse>;
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
  const isOffline = source === "fixture";

  // A committed decision. The comparison stays on screen and is marked stale
  // rather than cleared (CM-6): the reader just acted on those numbers, and
  // blanking them would take away what they were looking at.
  const [planChanged, setPlanChanged] = useState(false);
  const [commitResult, setCommitResult] = useState<string>();
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string>();

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

  /**
   * Replaces the twin with one the backend has already saved: the response to an
   * accepted Assistant proposal (AS-15), or an opening question answered in the
   * chat. The caller owns the request and its own waiting state, so this sets no
   * busy flag; it still clears the simulation, which that change may have made
   * stale, exactly as `updateTwin` does.
   */
  function applyTwin(next: FinancialTwin) {
    latestRequest.current += 1;
    setTwin(next);
    setSource("api");
    setSimulation(null);
    setSimulationError(undefined);
    clearOptimization();
  }

  async function refreshTwin() {
    const loaded = await getTwin(DEMO_USER_ID);
    latestRequest.current += 1;
    setTwin(loaded.data);
    setSource(loaded.source);
    setSimulation(null);
    setSimulationError(undefined);
    clearOptimization();
  }

  function setMinimum(amount: number) {
    if (!twin) return;
    if (isOffline) {
      setTwinUpdateError(OFFLINE_REASON);
      return;
    }
    void updateTwin(setMinimumBalance(twin, { amount }), MINIMUM_BALANCE_SCOPE);
  }

  async function simulate(event: SimulationEvent) {
    if (!twin) return;
    if (isOffline) {
      setSimulationError(OFFLINE_REASON);
      return;
    }
    const request = ++latestRequest.current;
    setIsSimulating(true);
    setSimulationError(undefined);
    clearOptimization();
    // The new run is against the plan as it now stands, so the stale mark and
    // the previous commit notice both go with it (CM-6).
    setPlanChanged(false);
    setCommitResult(undefined);
    setCommitError(undefined);
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
    if (isOffline) {
      setOptimizationError(OFFLINE_REASON);
      return;
    }
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

  /**
   * Adds a decided purchase to the plan, with an optional deadline move in the
   * same call (section 10, CM-3 to CM-6).
   *
   * The response carries the whole twin (API-2), so that is what the twin is
   * replaced with; a second read would only be a slower way to learn the same
   * thing. The simulation is deliberately left standing and marked stale.
   *
   * G-16: a 404 or 409 means the thing being written against moved under the
   * reader, so the twin is re-read and they are asked to look again.
   */
  async function commit(
    events: SimulationEvent[],
    goalUpdates?: GoalDateChange[],
  ): Promise<boolean> {
    if (!twin || isCommitting) return false;
    setIsCommitting(true);
    setCommitError(undefined);
    try {
      const response = await commitPurchase(twin.user_id, {
        events,
        goal_updates: goalUpdates,
      });
      setTwin(response.twin);
      setSource("api");
      setPlanChanged(true);
      setCommitResult(
        response.already_committed
          ? "That purchase was already in your plan."
          : "Added to your plan. It is in Obligations, where you can delete it.",
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        setCommitError("That changed. Please review and try again.");
        const loaded = await getTwin(DEMO_USER_ID).catch(() => null);
        if (loaded?.source === "api") setTwin(loaded.data);
      } else {
        setCommitError(errorText(error));
      }
      return false;
    } finally {
      setIsCommitting(false);
    }
  }

  /** CM-2. Throws on 404 and 422 so the caller can show the backend's words. */
  async function earliestDate(
    goalId: string,
    events: SimulationEvent[],
  ): Promise<EarliestDateResponse> {
    if (!twin) throw new Error("No twin loaded.");
    return findEarliestDate(twin.user_id, goalId, { events });
  }

  const value: TwinState = {
    twin,
    source,
    isOffline,
    twinError,
    isBusy,
    savingScope,
    twinUpdateError,
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
    applyTwin,
    refreshTwin,
    setMinimum,
    simulate,
    optimize,
    commit,
    earliestDate,
  };

  return <TwinContext.Provider value={value}>{children}</TwinContext.Provider>;
}

/** Throws outside the provider rather than handing back a silently empty twin. */
export function useTwin(): TwinState {
  const value = useContext(TwinContext);
  if (!value) throw new Error("useTwin must be used inside a TwinProvider");
  return value;
}
