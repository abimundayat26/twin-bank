"use client";

/**
 * Overview: what Alex's money looks like now, and how its parts relate.
 *
 * One job (SPEC section 3.1): the accounts, the Intent Graph, and concise
 * summaries of what is planned. The goal compiler, the obligation editor, the
 * purchase form and the full trajectory live on their own pages, reachable from
 * the menu and from the calls to action below.
 */

import Link from "next/link";
import { AccountsPanel } from "@/components/twin/AccountsPanel";
import { IncomePanel } from "@/components/twin/IncomePanel";
import { GoalsSummary, ObligationsSummary } from "@/components/twin/PlanSummary";
import { SpendingPanel } from "@/components/twin/SpendingPanel";
import { IntentGraph } from "@/components/IntentGraph";
import { Card } from "@/components/ui";
import { useTwin } from "@/lib/state/TwinProvider";

export default function Home() {
  const { twin, twinError, simulation } = useTwin();

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

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-ink">
          {twin.display_name}&rsquo;s Financial Twin
        </h1>
        <p className="text-sm text-muted">
          What the bank observed, plus what {twin.display_name} declared. TwinBank projects
          what happens next; it never guesses a goal from transactions.
        </p>
      </div>

      {/* Full width and first: the structure of the money is what makes this
          more than a budgeting dashboard (SPEC §1). */}
      <div className="mb-6">
        <IntentGraph twin={twin} simulation={simulation} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[360px_1fr] lg:items-start">
        <div className="grid gap-4">
          <AccountsPanel twin={twin} />
          <IncomePanel twin={twin} />
          <SpendingPanel twin={twin} />
        </div>

        <div className="grid gap-4">
          <GoalsSummary twin={twin} />
          <ObligationsSummary twin={twin} />

          <Card title="What next?">
            <div className="flex flex-wrap gap-3">
              <Link
                href="/simulate"
                className="rounded-lg border border-counter px-4 py-2.5 text-sm font-semibold text-counter transition hover:bg-counter/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter"
              >
                Simulate a purchase
              </Link>
              <Link
                href="/plans"
                className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-baseline"
              >
                Add a goal
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
