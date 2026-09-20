import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ObligationsPage from "./page";

describe("Obligations route shell", () => {
  it("names the route without exposing unfinished CRUD controls", () => {
    render(<ObligationsPage />);

    expect(screen.getByRole("heading", { name: "Obligations", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Obligation management is coming next/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add|Save|Delete/ })).not.toBeInTheDocument();
  });
});
