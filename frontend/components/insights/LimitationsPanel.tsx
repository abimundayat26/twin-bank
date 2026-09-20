/**
 * What this page cannot tell you, assembled from the twin itself. Props only.
 *
 * The list is derived rather than written out, so it can never claim a
 * limitation the twin does not have — or hide one it does. Everything here is
 * either a property of the loaded twin or a contract that does not exist yet.
 */

import type { DataSource } from "@/lib/api";
import { openQuestions } from "@/lib/obligations";
import { seasonalSummary } from "@/lib/seasonal";
import type { FinancialTwin } from "@/lib/types";
import { Card } from "../ui";

function label(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function limitations(twin: FinancialTwin, backend: DataSource | undefined): string[] {
  const items: string[] = [];

  if (backend === "fixture") {
    items.push(
      "The backend did not answer, so this twin is the copy bundled with the frontend. Nothing on this page reflects a live read of anything.",
    );
  } else if (twin.source === "fixture" || twin.source === "databricks") {
    items.push(
      "The figures describe TwinBank's demo fixture, not a real account. They are shaped like bank data; they did not come from a bank.",
    );
  } else if (!twin.source) {
    items.push(
      "The backend did not report where this twin came from, so its origin cannot be confirmed on this page.",
    );
  }

  if (!twin.forecast) {
    items.push(
      "No forecast metadata was recorded for this twin, so the estimation method, observation window and recency weighting are unavailable.",
    );
  }

  const flat = twin.variable_spending.filter(
    (bucket) => !bucket.seasonal || !seasonalSummary(bucket.seasonal),
  );
  if (flat.length > 0) {
    items.push(
      `TwinBank found no reliable seasonal pattern for ${flat
        .map((bucket) => label(bucket.category))
        .join(", ")}, so ${flat.length === 1 ? "it is" : "they are"} projected flat across the year.`,
    );
  }

  const questions = openQuestions(twin);
  if (questions.length > 0) {
    items.push(
      `${questions.length === 1 ? "One payment is" : `${questions.length} payments are`} still unclassified. Until you answer, projections use what the transactions alone suggested.`,
    );
  }

  items.push(
    "Seasonal factors are fitted to the history observed. They say how past months differed from an average one, not what a particular month ahead will cost.",
  );
  items.push(
    "Pipeline run status, published dataset versions and MLflow run metadata are not exposed by any endpoint yet, so no tracked run can be named here.",
  );
  items.push(
    "The browser receives the summarized twin only — never transactions, credentials or connection settings.",
  );

  return items;
}

export function LimitationsPanel({
  twin,
  backend,
}: {
  twin: FinancialTwin;
  backend: DataSource | undefined;
}) {
  return (
    <Card title="Limitations" subtitle="What is assumed, and what TwinBank cannot tell you">
      <ul className="grid gap-2">
        {limitations(twin, backend).map((item) => (
          <li key={item} className="flex gap-2 text-sm text-muted">
            <span aria-hidden="true" className="text-faint">
              &middot;
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
