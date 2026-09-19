"use client";

/**
 * The Financial Intent Graph: how Alex's money moves, and what it is declared for.
 *
 * React Flow is a renderer here and nothing more. Every node, edge, label and
 * line width comes from `lib/graph.ts`, which is pure and tested on its own —
 * necessarily, because React Flow measures 0x0 under jsdom and a test that
 * rendered this component could not see a thing.
 */

import { useMemo } from "react";
import { Background, Controls, ReactFlow, useEdgesState, useNodesState } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { buildIntentGraph, describeIntentGraph, type IntentGraph as Graph } from "@/lib/graph";
import type { FinancialTwin, SimulationResponse } from "@/lib/types";
import { IntentNode } from "./IntentNode";
import { Card } from "./ui";

// Defined once: a fresh object each render makes React Flow rebuild its node
// registry and warn about it.
const nodeTypes = { intent: IntentNode };

/**
 * React Flow's default screen-reader text offers to delete nodes and edges.
 * Neither is true here: `deleteKeyCode` is off and the graph is read-only, so the
 * default text promises an edit that silently does nothing.
 *
 * Both node keys are set to the same string deliberately. In @xyflow/react
 * 12.11.6 the two are crossed — the description rendered when keyboard a11y is
 * *enabled* (our case) is the one keyed `keyboardDisabled`. Overriding both means
 * the text stays correct whichever key upstream picks.
 */
const NODE_DESCRIPTION =
  "Select a node with enter or space, then move it with the arrow keys. " +
  "Nodes cannot be removed here: this is a picture of the twin, not an editor.";

const ariaLabelConfig = {
  "node.a11yDescription.default": NODE_DESCRIPTION,
  "node.a11yDescription.keyboardDisabled": NODE_DESCRIPTION,
  "edge.a11yDescription.default":
    "Edges are a flow the simulation engine computes, and cannot be edited here.",
} as const;

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-5 rounded bg-muted" aria-hidden="true" />
        Observed money movement
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="h-0 w-5 border-t border-dashed border-counter"
          aria-hidden="true"
        />
        Declared intent
      </span>
      <span className="text-faint">Line thickness is relative flow size, not a figure.</span>
    </div>
  );
}

/**
 * Owns the interactive copy of the graph, so a dragged node stays where it was
 * dropped. Remounted (via `key`) whenever the underlying graph changes, which
 * resets positions and re-runs `fitView` — the cheapest correct way to take in
 * a new purchase node.
 */
function Canvas({ graph }: { graph: Graph }) {
  const [nodes, , onNodesChange] = useNodesState(graph.nodes);
  const [edges, , onEdgesChange] = useEdgesState(graph.edges);

  return (
    <div className="h-[560px] w-full overflow-hidden rounded-lg border border-line bg-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        ariaLabelConfig={ariaLabelConfig}
        fitView
        fitViewOptions={{ padding: 0.06 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: false }}
        // The twin is not editable from here: this is a picture of what the
        // engine simulates, not an editor for it.
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        // A canvas that swallows the scroll wheel traps a presenter mid-demo.
        // Drag to pan, buttons to zoom. `preventScrolling` is the load-bearing one:
        // React Flow calls preventDefault() on the wheel event before it checks
        // whether zooming is enabled, so turning zoom off alone still freezes the
        // page under the cursor.
        preventScrolling={false}
        zoomOnScroll={false}
        panOnScroll={false}
        zoomOnDoubleClick={false}
      >
        <Background gap={24} className="text-line" color="currentColor" />
        <Controls showInteractive={false} className="!shadow-none" />
      </ReactFlow>
    </div>
  );
}

export function IntentGraph({
  twin,
  simulation,
}: {
  twin: FinancialTwin;
  simulation?: SimulationResponse | null;
}) {
  const graph = useMemo(() => buildIntentGraph(twin, simulation), [twin, simulation]);
  const label = useMemo(() => describeIntentGraph(twin, simulation), [twin, simulation]);

  // `Canvas` seeds its state once, so it is remounted whenever the underlying
  // graph changes. Keyed on the twin as well as the simulation: a refreshed twin
  // with no new simulation would otherwise leave a stale picture contradicting
  // the description beside it.
  const canvasKey = `${twin.user_id}:${twin.as_of}:${graph.nodes.length}:${
    simulation?.simulation_id ?? "none"
  }`;

  return (
    <Card
      title="Financial Intent Graph"
      subtitle={`What the bank observed, and what ${twin.display_name} declared it is for`}
    >
      {graph.nodes.length ? (
        <div className="grid gap-3">
          <Legend />
          {/* The canvas is positioned divs a screen reader cannot order, so the
              same structure is stated once in prose. */}
          <p className="sr-only">{label}</p>
          <Canvas key={canvasKey} graph={graph} />
        </div>
      ) : (
        <p className="text-sm text-muted">
          This twin has no accounts, so there is nothing to route money through.
        </p>
      )}
    </Card>
  );
}
