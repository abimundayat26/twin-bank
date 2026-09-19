"use client";

/**
 * One node of the Financial Intent Graph. Presentational: every string on it was
 * formatted in `lib/graph.ts` from a contract value.
 *
 * Handles are invisible anchors React Flow needs to attach edges to; a node with
 * none would leave its edges floating.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { IntentNode as IntentNodeType } from "@/lib/graph";
import { Badge, ProvenanceTag } from "./ui";
import { NODE_WIDTH } from "@/lib/graph";

/**
 * Declared intent is tinted; observed facts stay neutral (SPEC §2).
 *
 * Blue and red sit at almost the same luminance, so hue alone would not separate
 * observed from declared. Declared kinds also carry a heavier border, and every
 * node with a provenance states it in words via `ProvenanceTag` (SPEC §6, §11).
 */
const KIND_ACCENT: Record<IntentNodeType["data"]["kind"], string> = {
  income: "border-line",
  account: "border-baseline/70",
  obligation: "border-line",
  spending: "border-line",
  goal: "border-2 border-counter/70",
  reserve: "border-2 border-counter/70",
  checking_floor: "border-2 border-counter/70",
  purchase: "border-2 border-counter",
};

export function IntentNode({ data }: NodeProps<IntentNodeType>) {
  // A purchase carries no provenance — it is neither observed nor declared, but a
  // hypothesis — yet it is the one node the eye must find, so it is tinted too.
  const isTinted = data.provenance === "declared" || data.kind === "purchase";

  return (
    <div
      className={`rounded-xl border bg-raised px-3 py-2.5 shadow-sm ${KIND_ACCENT[data.kind]}`}
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Left} className="!border-line !bg-faint" />

      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-ink" title={data.title}>
          {data.title}
        </p>
        {data.provenance ? <ProvenanceTag provenance={data.provenance} /> : null}
      </div>

      <p
        className={`tnum mt-1 text-lg font-semibold ${isTinted ? "text-counter" : "text-ink"}`}
      >
        {data.value}
      </p>

      {data.hint ? (
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-faint">{data.hint}</p>
      ) : null}

      {data.flag ? (
        <div className="mt-2">
          <Badge tone={data.flag.tone}>{data.flag.text}</Badge>
        </div>
      ) : null}

      <Handle type="source" position={Position.Right} className="!border-line !bg-faint" />
    </div>
  );
}
