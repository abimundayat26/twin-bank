/**
 * Where the processing ran. Props only.
 *
 * Only half of SPEC section 3.5's lineage panel can be built honestly today:
 * `twin.source` distinguishes a local build from a Databricks one, and that is
 * the whole of what any endpoint exposes. Pipeline status, published dataset
 * versions and MLflow run metadata have no contract behind them yet, so they
 * are named as unavailable in the Limitations panel rather than drawn here.
 *
 * Section 3.5 is explicit that a decorative badge implying an integration ran
 * is worse than saying nothing, so this panel states the location in words and
 * carries no logo, chip or status light at all.
 */

import type { FinancialTwin } from "@/lib/types";
import { Card } from "../ui";

export function ProcessingPanel({ twin }: { twin: FinancialTwin }) {
  const inDatabricks = twin.source === "databricks";
  return (
    <Card title="Processing" subtitle="Where the work that produced this twin ran">
      <p className="text-sm text-ink">
        {inDatabricks ? "Built in Databricks." : "Built by the local pipeline."}
      </p>
      <p className="mt-1 text-sm text-muted">
        {inDatabricks
          ? "A Databricks job normalized the transactions and rebuilt the twin; TwinBank read the result it published."
          : "Normalization, recurrence detection and the spending estimates all ran inside the TwinBank backend on this machine. No Databricks job was involved in the twin on screen."}
      </p>
    </Card>
  );
}
