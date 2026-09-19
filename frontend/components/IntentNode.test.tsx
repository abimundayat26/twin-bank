/**
 * The graph's node, on its own. `IntentGraph` itself cannot be rendered under
 * jsdom — React Flow measures the canvas at 0x0 — so the node is tested here and
 * the graph's structure in `lib/graph.test.ts`.
 */

import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import type { IntentNodeData } from "@/lib/graph";
import { NODE_WIDTH } from "@/lib/graph";
import { IntentNode } from "./IntentNode";

/**
 * React Flow passes a whole NodeProps; the component reads only `data`. Its
 * `Handle`s read the React Flow store, so the node needs a provider around it.
 */
function node(data: Partial<IntentNodeData> = {}) {
  const props = {
    data: {
      kind: "account" as const,
      title: "Everyday Checking",
      value: "$2,100.00",
      ...data,
    },
  };
  return (
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <IntentNode {...(props as any)} />
    </ReactFlowProvider>
  );
}

const renderNode = (data: Partial<IntentNodeData> = {}) => render(node(data));

describe("IntentNode", () => {
  it("shows the title and the figure lib/graph already formatted", () => {
    renderNode();
    expect(screen.getByText("Everyday Checking")).toBeInTheDocument();
    expect(screen.getByText("$2,100.00")).toBeInTheDocument();
  });

  it("keeps a truncated title readable on hover", () => {
    renderNode({ title: "Recurring transfer of unclear purpose" });
    expect(screen.getByText("Recurring transfer of unclear purpose")).toHaveAttribute(
      "title",
      "Recurring transfer of unclear purpose",
    );
  });

  it("states provenance when the node has one", () => {
    renderNode({ provenance: "declared" });
    expect(screen.getByText("You declared")).toBeInTheDocument();
  });

  // A purchase is a hypothesis: neither observed nor declared.
  it("claims no provenance for a node that has none", () => {
    renderNode({ kind: "purchase", provenance: undefined });
    expect(screen.queryByText("You declared")).not.toBeInTheDocument();
    expect(screen.queryByText("Observed")).not.toBeInTheDocument();
  });

  it("tints declared intent and the hypothetical purchase, but not observed facts", () => {
    const { container, rerender } = renderNode({ kind: "goal", provenance: "declared" });
    expect(container.querySelector(".text-counter")).toBeInTheDocument();

    rerender(node({ kind: "purchase", title: "Laptop", value: "-$800" }));
    expect(container.querySelector(".text-counter")).toBeInTheDocument();

    rerender(node({ kind: "income", title: "Job", value: "$720", provenance: "observed" }));
    expect(container.querySelector(".text-counter")).not.toBeInTheDocument();
  });

  it("shows a hint and a flag only when the graph supplied them", () => {
    const { container } = renderNode();
    expect(container.querySelectorAll("p")).toHaveLength(2);


    renderNode({ hint: "Due the 1st", flag: { text: "Unclassified", tone: "caution" } });
    expect(screen.getByText("Due the 1st")).toBeInTheDocument();
    expect(screen.getByText("Unclassified")).toBeInTheDocument();
  });

  it("is laid out at the width lib/graph positions nodes by", () => {
    const { container } = renderNode();
    expect(container.querySelector("div > div")).toHaveStyle({ width: `${NODE_WIDTH}px` });
  });

  // Without both handles, React Flow has nothing to attach an edge to.
  it("carries an anchor on each side for its edges", () => {
    const { container } = renderNode();
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(2);
  });
});
