/**
 * Where this twin's observed half came from, and when it was last read. Props only.
 *
 * The badge is `provenanceLabel`, the same two facts the header carries. The
 * sentence under it exists because a badge is a label, not an explanation: this
 * page is the one place with room to say plainly that demo figures are demo
 * figures (SPEC section 3.5).
 */

import type { DataSource } from "@/lib/api";
import { longDate } from "@/lib/format";
import { provenanceLabel } from "@/lib/provenance";
import type { FinancialTwin } from "@/lib/types";
import { Badge, Card, Row } from "../ui";

/**
 * One sentence per origin.
 *
 * An unreachable backend wins over the twin's own `source`, for the reason
 * `provenanceLabel` gives it precedence: whatever the twin says it is, the copy
 * on screen came out of the bundle.
 *
 * The Databricks wording says where the work ran, never whose money it
 * describes — the job's documented input is an uploaded copy of the demo
 * transactions (`backend/src/backend/twin_source.py`).
 */
function originSentence(backend: DataSource | undefined, twin: FinancialTwin): string {
  if (backend === "fixture") {
    return (
      "The backend could not be reached, so everything here is the example twin bundled " +
      "with the app. It is not bank data of any kind."
    );
  }
  switch (twin.source) {
    case "nessie":
      return (
        "Accounts and transaction history were read from the Nessie sandbox, then normalized " +
        "into the structure below."
      );
    case "databricks":
      return (
        "This twin was built by the Databricks job from an uploaded copy of the demo " +
        "transactions. That says where the work ran, not whose money it describes."
      );
    case "fixture":
      return (
        "These figures come from TwinBank's demo fixture. No bank was contacted, and nothing " +
        "here describes a real account."
      );
    default:
      return (
        "The backend answered but did not say where this twin came from, so TwinBank cannot " +
        "tell you either."
      );
  }
}

export function DataSourcePanel({
  twin,
  backend,
}: {
  twin: FinancialTwin;
  /** Whether the backend answered, from `lib/api`. Reachability only. */
  backend: DataSource | undefined;
}) {
  const provenance = provenanceLabel(backend, twin.source);
  return (
    <Card title="Data source" subtitle="What TwinBank read, and when it was last read">
      {provenance ? (
        <p className="mb-3">
          <Badge tone={provenance.tone}>{provenance.label}</Badge>
        </p>
      ) : null}

      <p className="text-sm text-muted">{originSentence(backend, twin)}</p>

      <ul className="mt-3">
        <Row
          label="Last day of observed data"
          hint="The twin's as-of date. Nothing after it has been observed."
          value={longDate(twin.as_of)}
        />
        <Row
          label="Accounts read"
          value={twin.accounts.length === 1 ? "1 account" : `${twin.accounts.length} accounts`}
        />
        <Row
          label="Observation window"
          hint={
            twin.forecast
              ? "The span of history the estimates were fitted to"
              : "Recorded only when the twin was rebuilt from transactions"
          }
          value={
            twin.forecast
              ? `${longDate(twin.forecast.window_start)} – ${longDate(twin.forecast.as_of)}`
              : "Not recorded"
          }
        />
      </ul>
    </Card>
  );
}
