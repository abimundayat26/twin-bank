"use client";

/**
 * Balance Trajectory: the detailed projection behind the latest simulation.
 *
 * The simulation lives in the provider, so arriving here from the simulator
 * shows the same result rather than re-running it. With no simulation yet, the
 * page says what belongs here and links to the page that produces it
 * (SPEC sections 3.4 and 9).
 */

import Link from "next/link";
import { BalanceTrajectoryChart } from "@/components/BalanceTrajectoryChart";
import { Card, Row } from "@/components/ui";
import { longDate, money } from "@/lib/format";
import { useTwin } from "@/lib/state/TwinProvider";
import { emergencyReserve, primaryGoal } from "@/lib/twin";

export default function TrajectoryPage() {
  const { twin, simulation, simulationSource } = useTwin();

  if (!simulation || !twin) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <Card title="No projection yet">
          <p className="text-sm text-muted">
            This page shows the balance bands behind a simulation: the baseline future, the
            future with the purchase, the purchase marker, the goal deadline and the reserve
            line.
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
  const purchases = simulation.request.events;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Balance Trajectory</h1>
          <p className="text-sm text-muted">
            The projection behind the latest simulation, and what it assumed.
          </p>
        </div>
        <Link
          href="/simulate"
          className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-baseline"
        >
          Change the purchase
        </Link>
      </div>

      {simulationSource === "fixture" ? (
        <div className="mb-4">
          <Card title="Backend offline">
            <p className="text-sm text-caution">
              This is the saved example ($800 laptop), not your purchase. Your entries and
              answers are not applied until the backend is running.
            </p>
          </Card>
        </div>
      ) : null}

      <div className="grid gap-4">
        <BalanceTrajectoryChart
          bands={simulation.balance_bands}
          reserve={reserve?.amount}
          simulations={simulation.num_simulations}
          markers={[
            ...purchases.map((event) => ({
              date: event.date,
              label: event.description,
              tone: "counter" as const,
            })),
            ...(goal ? [{ date: goal.deadline, label: goal.name, tone: "faint" as const }] : []),
          ]}
        />

        <Card title="What this projection assumed" subtitle="The same numbers the chart is drawn from">
          <ul>
            <Row
              label="Horizon"
              hint="Where the projection stops"
              value={longDate(simulation.request.horizon_end ?? simulation.horizon_end)}
            />
            {/* Absent on a deterministic run, so say so rather than print "null". */}
            <Row
              label="Monte Carlo paths"
              hint="Separate futures simulated"
              value={
                simulation.num_simulations
                  ? String(simulation.num_simulations)
                  : "Not a Monte Carlo run"
              }
            />
            {purchases.map((event) => (
              <Row
                key={`${event.date}-${event.description}`}
                label={event.description}
                hint={`Hypothetical purchase on ${longDate(event.date)}`}
                value={money(event.amount)}
              />
            ))}
            {reserve ? (
              <Row
                label="Emergency reserve"
                hint="Checking plus savings must stay above this"
                value={money(reserve.amount)}
              />
            ) : null}
            {minimum ? (
              <Row
                label="Minimum checking balance"
                hint="Your own low-balance line"
                value={money(minimum.amount)}
              />
            ) : null}
            {goal ? (
              <Row
                label={goal.name}
                hint={`Goal deadline · ${longDate(goal.deadline)}`}
                value={money(goal.target_amount)}
              />
            ) : null}
          </ul>
          <p className="mt-4 text-sm text-muted">
            The shaded band covers the middle 80% of simulated futures: one in ten ends above
            it and one in ten below. A wider band means the estimate is less certain, not that
            the outcome is worse.
          </p>
        </Card>
      </div>
    </main>
  );
}
