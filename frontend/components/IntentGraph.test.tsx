/**
 * React Flow measures 0x0 under jsdom, so the *drawn* graph is covered by
 * `lib/graph.test.ts`. What can be tested here is everything around it: the
 * introduction, the legend, the Reset control, and the non-canvas list that
 * frontend/SPEC.md 5.3 requires — which is ordinary DOM and renders fine.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import mockTwin from "@/lib/mock/twin.json";
import type { FinancialTwin } from "@/lib/types";
import { IntentGraph } from "./IntentGraph";

const TWIN = mockTwin as unknown as FinancialTwin;

describe("IntentGraph", () => {
  it("says why there is nothing to draw for a twin with no accounts", () => {
    render(<IntentGraph twin={{ ...TWIN, accounts: [] }} />);
    expect(
      screen.getByText(/no accounts, so there is nothing to route money through/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Observed money movement")).not.toBeInTheDocument();
  });

  it("introduces the graph in plain words before drawing anything", () => {
    render(<IntentGraph twin={TWIN} />);
    expect(screen.getByText(/Money flows left to right/)).toBeInTheDocument();
  });

  it("shows the legend, so the line styles mean something", () => {
    render(<IntentGraph twin={TWIN} />);
    expect(screen.getByText("Observed money movement")).toBeInTheDocument();
    expect(screen.getByText("Declared intent")).toBeInTheDocument();
  });

  it("offers a way back to the default layout after dragging nodes around", () => {
    render(<IntentGraph twin={TWIN} />);
    expect(screen.getByRole("button", { name: "Reset layout" })).toBeInTheDocument();
  });

  it("reads as a list as well as a picture", () => {
    // SPEC 5.3: a non-canvas representation, for accessibility and for screens
    // where the complete graph would be unreadable. Both copies are in the DOM;
    // CSS decides which one a given width shows, so two matches is correct.
    render(<IntentGraph twin={TWIN} />);
    expect(screen.getAllByText("Accounts").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Goals").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Everyday Checking").length).toBeGreaterThan(0);
  });

  it("names whose twin is being pictured", () => {
    render(<IntentGraph twin={{ ...TWIN, accounts: [], display_name: "Alex" }} />);
    expect(
      screen.getByText("What the bank observed, and what Alex declared it is for"),
    ).toBeInTheDocument();
  });
});
