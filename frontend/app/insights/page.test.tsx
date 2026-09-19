import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ForecastPage from "./page";

describe("Forecast & Data", () => {
  // SPEC 15.1: a planned capability must not be presented as an available one.
  it("says the page is not filled in rather than showing dead controls", () => {
    render(<ForecastPage />);
    expect(screen.getByRole("heading", { name: "Forecast & Data" })).toBeInTheDocument();
    expect(screen.getByText(/This page is not filled in yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says what will live here and where the feature is today", () => {
    render(<ForecastPage />);
    expect(screen.getByText(/Where the twin's observed half came from/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/");
  });
});
