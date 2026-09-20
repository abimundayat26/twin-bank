import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge, Card, ProvenanceTag, Row } from "./ui";

describe("Card", () => {
  it("renders its children with no header when unlabelled", () => {
    render(<Card>body</Card>);
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("gives a titled card a real heading, not styled text", () => {
    render(<Card title="Savings goals">body</Card>);
    expect(screen.getByRole("heading", { name: "Savings goals" })).toBeInTheDocument();
  });

  it("shows a subtitle only alongside a title", () => {
    const { rerender } = render(
      <Card title="Savings goals" subtitle="1 active goal">
        body
      </Card>,
    );
    expect(screen.getByText("1 active goal")).toBeInTheDocument();

    rerender(<Card subtitle="orphaned">body</Card>);
    expect(screen.queryByText("orphaned")).not.toBeInTheDocument();
  });
});

describe("ProvenanceTag", () => {
  // SPEC section 2: TwinBank never presents an inference as something Alex said.
  it("keeps what Alex declared apart from what the bank observed", () => {
    const { rerender } = render(<ProvenanceTag provenance="declared" />);
    expect(screen.getByText("You declared")).toBeInTheDocument();

    rerender(<ProvenanceTag provenance="observed" />);
    expect(screen.getByText("Observed")).toBeInTheDocument();
    expect(screen.queryByText("You declared")).not.toBeInTheDocument();
  });
});

describe("Badge", () => {
  it("carries its tone in a class, so colour is not the only signal", () => {
    const { container } = render(<Badge tone="bad">Over</Badge>);
    expect(container.firstChild).toHaveClass("text-bad");
    expect(screen.getByText("Over")).toBeInTheDocument();
  });

  it("defaults to a neutral tone", () => {
    const { container } = render(<Badge>Plain</Badge>);
    expect(container.firstChild).toHaveClass("text-muted");
  });
});

describe("Row", () => {
  it("shows its label, value and optional hint", () => {
    render(
      <ul>
        <Row label="Rent" hint="Due the 1st" value="$1,200" />
      </ul>,
    );
    expect(screen.getByText("Rent")).toBeInTheDocument();
    expect(screen.getByText("Due the 1st")).toBeInTheDocument();
    expect(screen.getByText("$1,200")).toBeInTheDocument();
  });

  it("omits the hint line rather than leaving it empty", () => {
    const { container } = render(
      <ul>
        <Row label="Rent" value="$1,200" />
      </ul>,
    );
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("renders whatever meta it is handed", () => {
    render(
      <ul>
        <Row label="Rent" value="$1,200" meta={<Badge>Observed</Badge>} />
      </ul>,
    );
    expect(screen.getByText("Observed")).toBeInTheDocument();
  });

  it("wraps long labels and stacks the value on narrow screens instead of clipping them", () => {
    const label =
      "Recurring transfer of unclear purpose (destination unclear — possibly savings or repayment)";
    render(
      <ul>
        <Row label={label} hint="Possibly several categories" value="$75" meta={<Badge>Unanswered</Badge>} />
      </ul>,
    );

    const text = screen.getByText(label);
    expect(text).toHaveClass("break-words");
    expect(text).not.toHaveClass("truncate");
    expect(text.closest("li")).toHaveClass("flex-col", "sm:flex-row");
  });
});
