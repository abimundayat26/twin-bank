/**
 * Where the work that produced this twin ran (SPEC section 3.5, panel 4).
 * Props only.
 *
 * `ProcessingLineage` is an agreed contract that no backend populates yet, so
 * `twin.lineage` is null on every twin the demo serves today. That is not a
 * reason to draw a placeholder: section 3.5 is explicit that a decorative badge
 * implying an integration ran is worse than saying nothing, and section 15.1
 * forbids a planned capability wearing active-looking controls. So this panel
 * has no logo, chip, status light or refresh button at all — it states in words
 * what the backend reported, and says plainly when it reported nothing.
 *
 * Section 15.2's states all fall out of the contract's four fields: a published
 * Databricks run (`succeeded`), a run TwinBank cannot vouch for — still going,
 * or its outcome never read (`unknown`), a run that failed (`failed`), the
 * local pipeline (`location: "local"`), and no lineage at all from a backend
 * that predates the contract (null). A failed or unconfirmed run never blanks
 * the twin: the figures on screen are the last build that completed, and this
 * panel says so beside the date they were observed through, which keeps data
 * freshness and service availability separate facts.
 *
 * Nothing here can leak a connection value: the contract carries no host, path
 * or setting, and the one identifier it does carry is rendered only when it
 * matches MLflow's own run-id shape.
 */

import type { DataSource } from "@/lib/api";
import { longDate, longDateTime } from "@/lib/format";
import type { FinancialTwin, ProcessingLineage } from "@/lib/types";
import { Card, Row } from "../ui";

/** MLflow's run-id shape, the same pattern `schemas.py` enforces. */
const RUN_ID = /^[0-9a-f]{32}$/;

const STATUS_LABEL: Record<ProcessingLineage["status"], string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  unknown: "Not reported",
};

/**
 * Where the work ran, and what that means.
 *
 * `lineage.location` is how the twin was *produced*; `twin.source` is where its
 * data *came from*. They are separate facts and either can arrive without the
 * other, so a local build of Databricks-published data is described as exactly
 * that rather than collapsed into one claim. With no lineage at all, the
 * source is the only thing left to go on.
 */
function where(
  twin: FinancialTwin,
  location: ProcessingLineage["location"] | null,
): { headline: string; detail: string } {
  const fromDatabricks = twin.source === "databricks";
  if (location === "databricks" || (location === null && fromDatabricks)) {
    return {
      headline: "Built in Databricks.",
      detail:
        "A Databricks job normalized the transactions and rebuilt the twin; TwinBank read the result it published.",
    };
  }
  return {
    headline: "Built by the local pipeline.",
    detail: fromDatabricks
      ? "The twin on screen was assembled by the TwinBank backend on this machine, from data a Databricks job published. Where the work ran and where the data came from are separate facts."
      : "Normalization, recurrence detection and the spending estimates all ran inside the TwinBank backend on this machine. No Databricks job was involved in the twin on screen.",
  };
}

/** What the run's outcome means for the twin currently on screen. */
function statusSentence(status: ProcessingLineage["status"], asOf: string): string {
  switch (status) {
    case "succeeded":
      return "The run that produced this twin finished successfully, and its output is what the rest of TwinBank projects from.";
    case "failed":
      return `The most recent run TwinBank was told about failed. Nothing has been blanked: the figures on screen are the last build that completed, observed through ${longDate(asOf)}, and they have not been rebuilt since.`;
    case "unknown":
      return `TwinBank was not told how that run finished — it may still be going, or its outcome was never read. The twin on screen is the last one that loaded, observed through ${longDate(asOf)}, and is shown in full either way.`;
  }
}

export function ProcessingPanel({
  twin,
  backend,
}: {
  twin: FinancialTwin;
  /** Whether the backend answered, from `lib/api`. Reachability only. */
  backend: DataSource | undefined;
}) {
  // An unreachable backend outranks anything the twin says about itself: the
  // copy on screen came out of the bundle, so no pipeline produced it at all.
  if (backend === "fixture") {
    return (
      <Card title="Processing" subtitle="Where the work that produced this twin ran">
        <p className="text-sm text-ink">Nothing was processed for this screen.</p>
        <p className="mt-1 text-sm text-muted">
          The backend did not answer, so the twin on screen is the example copy bundled with
          the app. No pipeline ran for it — locally or in Databricks — and there is nothing to
          report about one.
        </p>
      </Card>
    );
  }

  const lineage = twin.lineage ?? null;
  const { headline, detail } = where(twin, lineage?.location ?? null);
  const runTime = lineage?.run_time ? longDateTime(lineage.run_time) : null;
  const reportedId = lineage?.mlflow_run_id ?? null;
  const runId = reportedId && RUN_ID.test(reportedId) ? reportedId : null;

  return (
    <Card title="Processing" subtitle="Where the work that produced this twin ran">
      <p className="text-sm text-ink">{headline}</p>
      <p className="mt-1 text-sm text-muted">{detail}</p>

      {lineage ? (
        <>
          <p className="mt-3 text-sm text-muted">{statusSentence(lineage.status, twin.as_of)}</p>
          <ul className="mt-3">
            <Row
              label="Run status"
              hint="How the run that produced this twin finished"
              value={STATUS_LABEL[lineage.status]}
            />
            {runTime ? (
              <Row label="Run time" hint="Shown in UTC" value={runTime} />
            ) : null}
            {runId ? (
              <Row label="MLflow run" hint="The tracked run's identifier" value={runId} />
            ) : null}
          </ul>
          {runId ? null : (
            <p className="mt-2 text-xs text-faint">
              {reportedId
                ? "The backend reported an MLflow run id in a shape TwinBank does not recognize, so it is not shown."
                : "No MLflow run was recorded for this build, so there is no tracked run to name."}
            </p>
          )}
        </>
      ) : (
        <p className="mt-3 text-sm text-muted">
          This backend reported no processing lineage with the twin, so TwinBank cannot name the
          run that produced it, say how that run finished, or say when it happened. That is
          metadata the backend did not send, not evidence that a run failed.
        </p>
      )}
    </Card>
  );
}
