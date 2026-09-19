/**
 * Two separate facts, deliberately not collapsed into one.
 *
 * Whether the backend answered is about *reachability*; where the twin's
 * observed half came from is about *data origin*. A live backend with no Nessie
 * key still serves fixture-derived data, so "the backend answered" must never
 * be allowed to read as "this is real bank data".
 *
 * The four combinations below are fixed by `frontend/SPEC.md` section 8.
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

  if (twinSource === "nessie") {
    return {
      backend: "Backend connected",
      data: "Nessie data",
      label: "Backend connected · Nessie data",
      tone: "good",
    };
  }

  if (twinSource === "fixture") {
    return {
      backend: "Backend connected",
      data: "Demo fixture",
      label: "Backend connected · Demo fixture",
      tone: "caution",
    };
  }

  // The backend answered but named no source: say so rather than assuming one.
  return {
    backend: "Backend connected",
    data: "Data source unavailable",
    label: "Backend connected · Data source unavailable",
    tone: "caution",
  };
}
