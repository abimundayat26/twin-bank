/**
 * The "Why?" section. Every word and number here is structured fixture data
 * from the contract (`summary`, `drivers[]`, `assumptions[]`) — the frontend
 * does not generate or infer explanations.
 */

import { signedMoney } from "@/lib/format";
import type { SimulationResponse } from "@/lib/types";
import { Card } from "./ui";

export function ExplanationPanel({ simulation }: { simulation: SimulationResponse }) {
  return (
    <Card title="Why?" subtitle="What moves the numbers, and what we assumed">
      <p className="text-sm leading-relaxed text-ink">{simulation.summary}</p>

      <h3 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        Biggest drivers
      </h3>
      <ul className="grid gap-2">
        {simulation.drivers.map((driver) => {
          const negative = driver.direction === "negative";
          return (
            <li
              key={driver.label}
              className="rounded-lg border border-line bg-raised p-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium text-ink">{driver.label}</p>
                <span
                  className={`tnum shrink-0 text-sm font-semibold ${
                    negative ? "text-bad" : "text-good"
                  }`}
                >
                  {signedMoney(driver.impact_amount)}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{driver.detail}</p>
            </li>
          );
        })}
      </ul>

      <h3 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        Assumptions
      </h3>
      <ul className="grid gap-1.5">
        {simulation.assumptions.map((assumption) => (
          <li key={assumption} className="flex gap-2 text-xs leading-relaxed text-muted">
            <span className="text-faint">·</span>
            <span>{assumption}</span>
          </li>
        ))}
      </ul>

      <p className="mt-6 text-xs text-faint">
        Simulation {simulation.simulation_id}. TwinBank shows the tradeoff; the
        decision is yours.
      </p>
    </Card>
  );
}
