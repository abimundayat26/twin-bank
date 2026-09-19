import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FinancialObligation } from "@/lib/types";
import { CategoryQuestion } from "./CategoryQuestion";

const UNCLEAR: FinancialObligation = {
  id: "obl_mystery_transfer",
  name: "Recurring transfer of unclear purpose",
  expected_amount: 200,
  due_day: 3,
  mandatory: false,
  confidence: 0.8,
  provenance: "observed",
  category_candidates: [
    { category: "savings_transfer", probability: 0.45 },
    { category: "debt_repayment", probability: 0.3 },
    { category: "not_recurring", probability: 0.25 },
  ],
  declared_category: null,
};

function renderQuestion(obligation = UNCLEAR, props: Record<string, unknown> = {}) {
  const onAnswer = vi.fn();
  render(
    <ul>
      <CategoryQuestion
        obligation={obligation}
        isBusy={false}
        onAnswer={onAnswer}
        {...props}
      />
    </ul>,
  );
  return { onAnswer, user: userEvent.setup() };
}

describe("CategoryQuestion", () => {
  it("asks rather than deciding what an unclear transfer is", () => {
    renderQuestion();
    expect(screen.getByText("What is this?")).toBeInTheDocument();
    expect(screen.getByText("Due the 3rd")).toBeInTheDocument();
    expect(screen.getByText("$200")).toBeInTheDocument();
  });

  it("offers every candidate the backend ranked, with its probability", () => {
    renderQuestion();
    expect(screen.getByRole("button", { name: /Savings transfer/ })).toHaveTextContent(
      "Most likely · 45%",
    );
    expect(screen.getByRole("button", { name: /Debt repayment/ })).toHaveTextContent("30%");
    expect(screen.getByRole("button", { name: /Not recurring/ })).toHaveTextContent("25%");
  });

  it("marks only the first candidate as most likely", () => {
    renderQuestion();
    expect(screen.getAllByText(/Most likely/)).toHaveLength(1);
  });

  it("hands up the category Alex picked", async () => {
    const { onAnswer, user } = renderQuestion();
    await user.click(screen.getByRole("button", { name: /Debt repayment/ }));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("debt_repayment");
  });

  it("states a declared answer as Alex's own, and stops asking", () => {
    renderQuestion({ ...UNCLEAR, declared_category: "savings_transfer" });
    expect(screen.getByText("You declared: Savings transfer")).toBeInTheDocument();
    expect(screen.queryByText("What is this?")).not.toBeInTheDocument();
  });

  it("reopens the question on Change, without answering it again by itself", async () => {
    const { onAnswer, user } = renderQuestion({
      ...UNCLEAR,
      declared_category: "savings_transfer",
    });
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByText("What is this?")).toBeInTheDocument();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("blocks every answer while another twin update is in flight", () => {
    renderQuestion(UNCLEAR, { isBusy: true });
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });

  it("says Saving… only for the obligation being answered", () => {
    const { rerender } = render(
      <ul>
        <CategoryQuestion
          obligation={UNCLEAR}
          isBusy
          savingScope="obl_rent"
          onAnswer={vi.fn()}
        />
      </ul>,
    );
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();

    rerender(
      <ul>
        <CategoryQuestion
          obligation={UNCLEAR}
          isBusy
          savingScope={UNCLEAR.id}
          onAnswer={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByText("Saving…")).toBeInTheDocument();
  });

  // Edge case: an obligation with no candidates and no declared answer renders the
  // question with nothing to answer it with — a dead end the user cannot clear.
  it("does not ask a question it offers no answers to", () => {
    renderQuestion({ ...UNCLEAR, category_candidates: [] });
    expect(screen.queryByText("What is this?")).not.toBeInTheDocument();
  });
});
