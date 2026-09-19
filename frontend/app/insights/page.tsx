"use client";

/**
 * Forecast & Data: how TwinBank turned banking activity into the twin the rest
 * of the app projects from (SPEC section 3.5).
 *
 * This is the trust surface, so its job is to be honest before it is
 * impressive: it says where the observed half came from, what structure was
 * detected, how the estimates were made, where the work ran, and — at the same
 * size as everything else — what it cannot tell you.
 *
 * Read-only. Section 3.5 forbids a refresh or rebuild control until the backend
 * exposes an authenticated operation, and forbids simulating one in local
 * state, so nothing here writes anything. Everything rendered comes from
 * `GET /twin/{user_id}`; no panel invents a field the contract does not carry.
 */

import { DataSourcePanel } from "@/components/insights/DataSourcePanel";
import { DetectedStructurePanel } from "@/components/insights/DetectedStructurePanel";
import { ForecastPanel } from "@/components/insights/ForecastPanel";
import { LimitationsPanel } from "@/components/insights/LimitationsPanel";
import { ProcessingPanel } from "@/components/insights/ProcessingPanel";
import { Card } from "@/components/ui";
import { useTwin } from "@/lib/state/TwinProvider";

export default function ForecastPage() {
  const { twin, source, twinError } = useTwin();

  if (twinError) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <Card title="Could not load the Financial Twin">
          <p className="text-sm text-bad">{twinError}</p>
          <p className="mt-3 text-sm text-muted">
            This page only describes a twin that loaded. With none on screen there is nothing
            to explain, and TwinBank will not guess at where the data would have come from.
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

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-ink">Forecast &amp; Data</h1>
        <p className="text-sm text-muted">
          Where {twin.display_name}&rsquo;s observed half came from, what TwinBank detected in
          it, and how the numbers the simulator uses were estimated.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <div className="grid gap-4">
          <DataSourcePanel twin={twin} backend={source} />
          <ProcessingPanel twin={twin} />
          <DetectedStructurePanel twin={twin} />
        </div>

        <div className="grid gap-4">
          <ForecastPanel twin={twin} />
          <LimitationsPanel twin={twin} backend={source} />
        </div>
      </div>
    </main>
  );
}
