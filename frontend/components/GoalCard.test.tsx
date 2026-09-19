import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Goal } from "@/lib/types";
import { GoalCard } from "./GoalCard";

const GOAL: Goal = {
  id: "goal_summer_housing",
  name: "Summer housing",
  target_amount: 1600,
  deadline: "2027-05-01",
  current_amount: 400,
  provenance: "declared",
};

/** The bar is display-only; its width must still be a usable CSS length. */
function barWidth(container: HTMLElement): string | undefined {
  const bar = container.querySelector<HTMLElement>(".bg-baseline");
  return bar?.style.width;
}

describe("GoalCard", () => {
  it("reads progress off the contract rather than recomputing it", () => {
    render(<GoalCard goal={GOAL} />);
    expect(screen.getByText("$400")).toBeInTheDocument();
    expect(screen.getByText("/ $1,600")).toBeInTheDocument();
    expect(screen.getByText("by May 1, 2027")).toBeInTheDocument();
    expect(screen.getByText("You declared")).toBeInTheDocument();
  });

  it("fills the bar in proportion to the declared progress", () => {
    const { container } = render(<GoalCard goal={GOAL} />);
    expect(barWidth(container)).toBe("25%");
  });

  it("clamps a goal already over its target to a full bar", () => {
    const { container } = render(
      <GoalCard goal={{ ...GOAL, current_amount: 2400 }} />,
    );
    expect(barWidth(container)).toBe("100%");
  });

  it("clamps negative progress to an empty bar", () => {
    const { container } = render(<GoalCard goal={{ ...GOAL, current_amount: -50 }} />);
    expect(barWidth(container)).toBe("0%");
  });

  // 0 / 0 is NaN, and `width: NaN%` is invalid CSS that the browser drops — the
  // bar then renders at its full default width, reading as a completed goal.
  it("does not draw a full bar for a goal with a zero target", () => {
    const { container } = render(
      <GoalCard goal={{ ...GOAL, target_amount: 0, current_amount: 0 }} />,
    );
    expect(barWidth(container)).toBe("0%");
  });

  it("has no remove control unless one is wired up", () => {
    render(<GoalCard goal={GOAL} />);
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  it("asks once more before removing, since the goal cannot be restored here", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(<GoalCard goal={GOAL} onRemove={onRemove} />);

    await user.click(screen.getByRole("button", { name: "Remove goal" }));
    expect(screen.getByText("Remove this goal?")).toBeInTheDocument();
    expect(onRemove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("goal_summer_housing");
  });

  it("backs out of the confirmation without removing anything", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(<GoalCard goal={GOAL} onRemove={onRemove} />);

    await user.click(screen.getByRole("button", { name: "Remove goal" }));
    await user.click(screen.getByRole("button", { name: "Keep it" }));

    expect(screen.queryByText("Remove this goal?")).not.toBeInTheDocument();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("blocks a second removal while a twin update is in flight", async () => {
    const onRemove = vi.fn();
    render(<GoalCard goal={GOAL} isBusy onRemove={onRemove} />);
    expect(screen.getByRole("button", { name: "Remove goal" })).toBeDisabled();
  });

  it("says Removing… only on the card whose own removal is saving", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <GoalCard goal={GOAL} savingScope="another_goal" isBusy onRemove={vi.fn()} />,
    );
    expect(screen.queryByText("Removing…")).not.toBeInTheDocument();

    rerender(<GoalCard goal={GOAL} savingScope={undefined} onRemove={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Remove goal" }));
    rerender(<GoalCard goal={GOAL} savingScope={GOAL.id} isBusy onRemove={vi.fn()} />);
    expect(screen.getByText("Removing…")).toBeInTheDocument();
  });
});
