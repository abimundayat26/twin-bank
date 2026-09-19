/**
 * Two separate facts, deliberately not collapsed into one.
 *
 * Whether the backend answered is about *reachability*; where the twin's
 * observed half came from is about *data origin*. A live backend with no Nessie
 * key still serves fixture-derived data, so "the backend answered" must never
 * be allowed to read as "this is real bank data".
 *
 * The combinations below are fixed by `frontend/SPEC.md` section 8, which lists
 * them as a floor rather than a closed set: Databricks is a source the backend
 * can report (`schemas.py`) that the table does not name yet.
 */

import type { DataSource } from "./api";
import type { FinancialTwin } from "./types";

export type ProvenanceTone = "good" | "caution";

export interface ProvenanceLabel {
  /** Reachability, e.g. "Backend connected". */
  backend: string;
  /** Data origin, e.g. "Nessie data". */
  data: string;
  /** The two joined for display, e.g. "Backend connected · Nessie data". */
  label: string;
  tone: ProvenanceTone;
}

const CONNECTED = "Backend connected";

/**
 * What each source the backend can report is called on screen.
 *
 * Keyed by the source union itself, so a fourth source added to `schemas.py`
 * fails to compile here instead of quietly displaying as an unknown one.
 *
 * Only Nessie earns the `good` tone. A Databricks twin was *built* in
 * Databricks, which says where the work ran, not whose money it describes: the
 * job's documented input is an uploaded copy of the demo transactions
 * (`backend/databricks.yml`). Calling it live bank data would be the exact
 * claim section 1 forbids.
 */
const DATA_ORIGIN: Record<
  NonNullable<FinancialTwin["source"]>,
  { data: string; tone: ProvenanceTone }
> = {
  nessie: { data: "Nessie data", tone: "good" },
  fixture: { data: "Demo fixture", tone: "caution" },
  databricks: { data: "Databricks build", tone: "caution" },
};

function connected(data: string, tone: ProvenanceTone): ProvenanceLabel {
  return { backend: CONNECTED, data, label: `${CONNECTED} · ${data}`, tone };
}

/**
 * `backend` is the transport result from `lib/api`; `twinSource` is the twin's
 * own `source` field as the backend reported it.
 *
 * Returns null while the first load is still in flight, so the caller renders
 * nothing rather than guessing.
 *
 * When the backend could not be reached, the twin on screen is the bundled
 * fixture whatever `twinSource` says, so the fallback wording always wins.
 */
export function provenanceLabel(
  backend: DataSource | undefined,
  twinSource: FinancialTwin["source"],
): ProvenanceLabel | null {
  if (!backend) return null;

  if (backend === "fixture") {
    return {
      backend: "Backend offline",
      data: "Bundled example",
      label: "Backend offline · Bundled example",
      tone: "caution",
    };
  }

  // A source the backend named but this build does not know is as good as no
  // source: say so rather than assuming one.
  const origin = twinSource ? DATA_ORIGIN[twinSource] : undefined;
  if (!origin) return connected("Data source unavailable", "caution");

  return connected(origin.data, origin.tone);
}
