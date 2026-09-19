/**
 * Only the branch that renders no canvas. React Flow measures 0x0 under jsdom,
 * so the drawn graph is covered by `lib/graph.test.ts` instead.
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

  it("names whose twin is being pictured", () => {
    render(<IntentGraph twin={{ ...TWIN, accounts: [], display_name: "Alex" }} />);
    expect(
      screen.getByText("What the bank observed, and what Alex declared it is for"),
    ).toBeInTheDocument();
  });
});
