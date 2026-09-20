/**
 * The composer is where a mis-merge would quietly delete a goal: `PUT
 * /twin/{id}/goals` replaces the whole declared set, so `onConfirm` must always
 * be handed everything the twin holds, not just what was typed.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GOALS_SCOPE } from "@/lib/scopes";
import type {
  FinancialConstraint,
  Goal,
  GoalClarification,
  GoalCompileResponse,
} from "@/lib/types";
import { GoalComposer } from "./GoalComposer";

const AS_OF = "2026-09-19";

const HOUSING: Goal = {
  id: "goal_summer_housing",
  name: "Summer housing",
  target_amount: 1600,
  deadline: "2027-05-01",
  current_amount: 250,
  provenance: "declared",
};

const RESERVE: FinancialConstraint = {
  id: "con_emergency_reserve",
  type: "minimum_reserve",
  amount: 1500,
  description: "Never let checking plus savings fall below $1,500.",
  provenance: "declared",
};

function draftOf(overrides: Partial<GoalCompileResponse> = {}): GoalCompileResponse {
  return {
    user_id: "alex",
    text: "I need $900 for a bike by June 1st",
    goals: [
      {
        id: "goal_a_bike",
        name: "A bike",
        target_amount: 900,
        deadline: "2027-06-01",
        current_amount: 0,
        provenance: "declared",
      },
    ],
    constraints: [],
    clarifications: [],
    unparsed: [],
    compiler: "rules",
    ...overrides,
  };
}

function renderComposer(props: Partial<Parameters<typeof GoalComposer>[0]> = {}) {
  const onCompile = vi.fn();
  const onConfirm = vi.fn();
  const onDiscard = vi.fn();
  const view = render(
    <GoalComposer
      goals={[HOUSING]}
      constraints={[RESERVE]}
      asOf={AS_OF}
      draft={null}
      isCompiling={false}
      isBusy={false}
      onCompile={onCompile}
      onConfirm={onConfirm}
      onDiscard={onDiscard}
      {...props}
    />,
  );
  return { ...view, onCompile, onConfirm, onDiscard, user: userEvent.setup() };
}

const box = () => screen.getByLabelText("Describe the goal");
const readBack = () => screen.getByRole("button", { name: /Read (this back to me|it again)/ });
const confirm = () => screen.getByRole("button", { name: /Confirm and update my twin|Saving…/ });

describe("composing", () => {
  it("cannot be read back until something has been typed", () => {
    renderComposer();
    expect(readBack()).toBeDisabled();
  });

  it("ignores a box holding only whitespace", async () => {
    const { user } = renderComposer();
    await user.type(box(), "    ");
    expect(readBack()).toBeDisabled();
  });

  it("sends the trimmed text to be compiled", async () => {
    const { onCompile, user } = renderComposer();
    await user.type(box(), "  I need $900 for a bike  ");
    await user.click(readBack());
    expect(onCompile).toHaveBeenCalledExactlyOnceWith("I need $900 for a bike");
  });

  it("says it is reading, and takes no second submission meanwhile", async () => {
    const { onCompile, user } = renderComposer({ isCompiling: true });
    await user.type(box(), "anything");
    expect(screen.getByRole("button", { name: "Reading…" })).toBeDisabled();
    expect(onCompile).not.toHaveBeenCalled();
  });

  it("caps the box at the 2,000 characters the contract allows", () => {
    renderComposer();
    expect(box()).toHaveAttribute("maxLength", "2000");
  });

  it("blames the backend for a failed compile rather than drafting a guess", () => {
    renderComposer({ compileError: "connection refused" });
    expect(screen.getByText(/Could not read that: connection refused/)).toBeInTheDocument();
    expect(screen.getByText(/nothing was drafted/)).toBeInTheDocument();
  });

  it("offers Discard only once there is a draft to discard", async () => {
    const { rerender, onDiscard, user } = renderComposer();
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();

    rerender(
      <GoalComposer
        goals={[HOUSING]}
        constraints={[RESERVE]}
        asOf={AS_OF}
        draft={draftOf()}
        isCompiling={false}
        isBusy={false}
        onCompile={vi.fn()}
        onConfirm={vi.fn()}
        onDiscard={onDiscard}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});

describe("keyboard operation", () => {
  // SPEC section 11: the presenter types the goal with the keyboard, so the box
  // must show focus rather than only recolouring its border.
  it("keeps a focus ring on the goal text box", () => {
    renderComposer();
    expect(screen.getByRole("textbox")).not.toHaveClass("outline-none");
    expect(screen.getByRole("textbox")).toHaveClass("focus-visible:outline");
  });
});

describe("reviewing a draft", () => {
  it("says whether rules or the model read the text", () => {
    const { rerender } = renderComposer({ draft: draftOf() });
    expect(screen.getByText("Read by rules")).toBeInTheDocument();

    rerender(
      <GoalComposer
        goals={[HOUSING]}
        constraints={[RESERVE]}
        asOf={AS_OF}
        draft={draftOf({ compiler: "llm" })}
        isCompiling={false}
        isBusy={false}
        onCompile={vi.fn()}
        onConfirm={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByText("Read by the model")).toBeInTheDocument();
  });

  it("shows the complete set that will be saved, not only the new goal", () => {
    renderComposer({ draft: draftOf() });
    expect(screen.getByText("A bike")).toBeInTheDocument();
    expect(screen.getByText("Summer housing")).toBeInTheDocument();
    expect(screen.getByText(RESERVE.description)).toBeInTheDocument();
  });

  // SPEC 7.1: a long goal name must stay readable in the review list.
  it("wraps a long goal name instead of clipping it", () => {
    const name = "Summer housing deposit and first month of shared apartment rent";
    renderComposer({
      draft: draftOf({ goals: [{ ...HOUSING, id: "goal_long", name }] }),
    });
    const label = screen.getByText(name);
    expect(label).not.toHaveClass("truncate");
    expect(label).toHaveClass("break-words");
  });

  it("wraps a long declared constraint instead of clipping it", () => {
    renderComposer({ draft: draftOf() });
    expect(screen.getByText(RESERVE.description)).toHaveClass("break-words");
  });

  it("labels what is new, what changed, and what is merely carried through", () => {
    renderComposer({ draft: draftOf() });
    const bike = screen.getByText("A bike").closest("li")!;
    expect(within(bike).getByText("new")).toBeInTheDocument();

    const housing = screen.getByText("Summer housing").closest("li")!;
    expect(within(housing).getByText("unchanged")).toBeInTheDocument();
  });

  it("marks a retyped goal as an update rather than adding a duplicate", () => {
    renderComposer({
      draft: draftOf({
        goals: [{ ...HOUSING, target_amount: 1800, current_amount: 0 }],
      }),
    });
    expect(screen.getAllByText("Summer housing")).toHaveLength(1);
    const housing = screen.getByText("Summer housing").closest("li")!;
    expect(within(housing).getByText("updated")).toBeInTheDocument();
  });

  it("distinguishes a constraint from this text from one merely kept", () => {
    renderComposer({
      draft: draftOf({
        constraints: [
          {
            id: "con_minimum_checking",
            type: "minimum_checking_balance",
            amount: 300,
            description: "Keep at least $300 in checking.",
            provenance: "declared",
          },
        ],
      }),
    });
    const floor = screen.getByText("Keep at least $300 in checking.").closest("li")!;
    expect(within(floor).getByText("from this")).toBeInTheDocument();

    const reserve = screen.getByText(RESERVE.description).closest("li")!;
    expect(within(reserve).getByText("kept")).toBeInTheDocument();
  });

  it("hands up every goal and constraint, so confirming erases nothing", async () => {
    const { onConfirm, user } = renderComposer({ draft: draftOf() });
    await user.click(confirm());

    const request = onConfirm.mock.calls[0][0];
    expect(request.goals.map((g: Goal) => g.id)).toEqual([
      "goal_summer_housing",
      "goal_a_bike",
    ]);
    expect(request.constraints).toEqual([RESERVE]);
  });

  it("keeps the progress already made when a goal is updated", async () => {
    const { onConfirm, user } = renderComposer({
      draft: draftOf({ goals: [{ ...HOUSING, target_amount: 1800, current_amount: 0 }] }),
    });
    await user.click(confirm());
    const saved = onConfirm.mock.calls[0][0].goals.find(
      (g: Goal) => g.id === "goal_summer_housing",
    );
    expect(saved.target_amount).toBe(1800);
    expect(saved.current_amount).toBe(250);
  });

  it("refuses to save a draft that parsed to nothing", () => {
    renderComposer({ draft: draftOf({ goals: [], constraints: [] }) });
    expect(screen.getByText(/Nothing here is complete enough to save yet/)).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
  });

  it("lists the fragments it could not read as a goal", () => {
    renderComposer({ draft: draftOf({ unparsed: ["and something about a car"] }) });
    expect(screen.getByText("Not read as a goal")).toBeInTheDocument();
    expect(screen.getByText("“and something about a car”")).toBeInTheDocument();
  });

  it("blocks a save while another twin update is in flight", () => {
    renderComposer({ draft: draftOf(), isBusy: true });
    expect(confirm()).toBeDisabled();
  });

  it("says Saving… only when this card's own save is running", () => {
    const { rerender } = renderComposer({
      draft: draftOf(),
      isBusy: true,
      savingScope: "goal_summer_housing",
    });
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();

    rerender(
      <GoalComposer
        goals={[HOUSING]}
        constraints={[RESERVE]}
        asOf={AS_OF}
        draft={draftOf()}
        isCompiling={false}
        isBusy
        savingScope={GOALS_SCOPE}
        onCompile={vi.fn()}
        onConfirm={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByText("Saving…")).toBeInTheDocument();
  });

  it("shows why a save was rejected and keeps the draft on screen", () => {
    renderComposer({ draft: draftOf(), saveError: "Goal ids must be unique" });
    expect(screen.getByText(/Could not save: Goal ids must be unique/)).toBeInTheDocument();
    expect(screen.getByText("A bike")).toBeInTheDocument();
  });
});

describe("correcting a drafted goal", () => {
  const amountBox = () => screen.getByLabelText("Target amount");
  const deadlineBox = () => screen.getByLabelText("Deadline");
  const progressBox = () => screen.getByLabelText("Already saved toward this");

  it("opens the changed rows for editing and leaves untouched ones read-only", () => {
    renderComposer({ draft: draftOf() });
    expect(amountBox()).toHaveValue(900);
    // The carried-through goal has no inputs of its own.
    expect(screen.getAllByLabelText("Target amount")).toHaveLength(1);
    expect(screen.getByText("$1,600")).toBeInTheDocument();
  });

  it("saves the corrected amount rather than the one that was read", async () => {
    const { onConfirm, user } = renderComposer({ draft: draftOf() });
    await user.clear(amountBox());
    await user.type(amountBox(), "1200");
    await user.click(confirm());

    const bike = onConfirm.mock.calls[0][0].goals.find((g: Goal) => g.id === "goal_a_bike");
    expect(bike.target_amount).toBe(1200);
  });

  it("refuses an amount of zero, as the backend does", async () => {
    const { user } = renderComposer({ draft: draftOf() });
    await user.clear(amountBox());
    await user.type(amountBox(), "0");
    expect(screen.getByText("Enter an amount above $0.")).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    expect(screen.getByText(/Fix the highlighted field before saving/)).toBeInTheDocument();
  });

  it("refuses a deadline that is not after the twin's as_of", async () => {
    const { user } = renderComposer({ draft: draftOf() });
    await user.clear(deadlineBox());
    await user.type(deadlineBox(), AS_OF);
    expect(screen.getByText(`Pick a date after ${AS_OF}.`)).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
  });

  it("refuses progress beyond the target", async () => {
    const { user } = renderComposer({ draft: draftOf() });
    await user.clear(progressBox());
    await user.type(progressBox(), "5000");
    expect(screen.getByText("This is more than the target.")).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
  });

  it("reads blank progress as none saved yet, not as a missing field", async () => {
    const { onConfirm, user } = renderComposer({ draft: draftOf() });
    await user.clear(progressBox());
    await user.click(confirm());
    const bike = onConfirm.mock.calls[0][0].goals.find((g: Goal) => g.id === "goal_a_bike");
    expect(bike.current_amount).toBe(0);
  });

  // Progress is the twin's, and the compiler never reads it, so an updated goal
  // must not offer to overwrite it.
  it("offers a progress field on a new goal only", () => {
    const { rerender } = renderComposer({ draft: draftOf() });
    expect(screen.getByLabelText("Already saved toward this")).toBeInTheDocument();

    rerender(
      <GoalComposer
        goals={[HOUSING]}
        constraints={[RESERVE]}
        asOf={AS_OF}
        draft={draftOf({ goals: [{ ...HOUSING, target_amount: 1800 }] })}
        isCompiling={false}
        isBusy={false}
        onCompile={vi.fn()}
        onConfirm={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Already saved toward this")).not.toBeInTheDocument();
  });

  // A correction typed against one reading must not carry over to the next.
  it("drops corrections when the text is read again", () => {
    const { rerender } = renderComposer({ draft: draftOf() });
    rerender(
      <GoalComposer
        goals={[HOUSING]}
        constraints={[RESERVE]}
        asOf={AS_OF}
        draft={draftOf({ text: "a different sentence" })}
        isCompiling={false}
        isBusy={false}
        onCompile={vi.fn()}
        onConfirm={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Target amount")).toHaveValue(900);
  });
});

describe("answering a clarification", () => {
  const AMOUNT_QUESTION: GoalClarification = {
    field: "amount",
    question: "How much do you need for a bike?",
    fragment: "I need a bike",
  };

  it("asks instead of guessing, and says what the question is about", () => {
    renderComposer({
      draft: draftOf({ goals: [], clarifications: [AMOUNT_QUESTION] }),
    });
    expect(screen.getByText("TwinBank will not guess these")).toBeInTheDocument();
    expect(screen.getByText("How much do you need for a bike?")).toBeInTheDocument();
    expect(screen.getByText("about “I need a bike” (amount)")).toBeInTheDocument();
  });

  it("hints at the shape of the answer it is expecting", () => {
    renderComposer({
      draft: draftOf({
        goals: [],
        clarifications: [{ ...AMOUNT_QUESTION, field: "deadline", question: "By when?" }],
      }),
    });
    expect(
      screen.getByPlaceholderText("e.g. May 1 2027, 2027-05-01, or in 6 months"),
    ).toBeInTheDocument();
  });

  it("cannot be answered with nothing", async () => {
    const { user } = renderComposer({
      draft: draftOf({ goals: [], clarifications: [AMOUNT_QUESTION] }),
    });
    const answer = screen.getByRole("button", { name: "Answer and read it again" });
    expect(answer).toBeDisabled();

    await user.type(screen.getByLabelText("How much do you need for a bike?"), "  ");
    expect(answer).toBeDisabled();
  });

  // The compiler is stateless and reads only text, so the answer is folded back
  // into the user's own words and the whole thing compiled again.
  it("folds the answer into the sentence and compiles it again", async () => {
    const { onCompile, user } = renderComposer({
      draft: draftOf({
        text: "I need a bike by June",
        goals: [],
        clarifications: [AMOUNT_QUESTION],
      }),
    });
    await user.type(screen.getByLabelText("How much do you need for a bike?"), "900");
    await user.click(screen.getByRole("button", { name: "Answer and read it again" }));

    expect(onCompile).toHaveBeenCalledExactlyOnceWith("I need a bike $900 by June");
  });

  it("puts the answer back in the box the user can still edit", async () => {
    const { user } = renderComposer({
      draft: draftOf({
        text: "I need a bike by June",
        goals: [],
        clarifications: [AMOUNT_QUESTION],
      }),
    });
    await user.type(screen.getByLabelText("How much do you need for a bike?"), "900");
    await user.click(screen.getByRole("button", { name: "Answer and read it again" }));
    expect(box()).toHaveValue("I need a bike $900 by June");
  });

  it("answers on Enter as well as on the button", async () => {
    const { onCompile, user } = renderComposer({
      draft: draftOf({
        text: "I need a bike by June",
        goals: [],
        clarifications: [AMOUNT_QUESTION],
      }),
    });
    await user.type(screen.getByLabelText("How much do you need for a bike?"), "900{Enter}");
    expect(onCompile).toHaveBeenCalledExactlyOnceWith("I need a bike $900 by June");
  });

  it("asks every outstanding question, not just the first", () => {
    renderComposer({
      draft: draftOf({
        goals: [],
        clarifications: [
          AMOUNT_QUESTION,
          { field: "deadline", question: "By when?", fragment: "I need a bike" },
        ],
      }),
    });
    expect(screen.getAllByRole("button", { name: "Answer and read it again" })).toHaveLength(2);
  });

  it("takes no answer while a compile is already running", () => {
    renderComposer({
      draft: draftOf({ goals: [], clarifications: [AMOUNT_QUESTION] }),
      isCompiling: true,
    });
    // Both the compile button and the question's own button say so.
    const reading = screen.getAllByRole("button", { name: "Reading…" });
    expect(reading).toHaveLength(2);
    for (const button of reading) expect(button).toBeDisabled();
  });

  it("can still save the goals it did understand while a question is open", async () => {
    const { onConfirm, user } = renderComposer({
      draft: draftOf({ clarifications: [AMOUNT_QUESTION] }),
    });
    expect(confirm()).toBeEnabled();
    await user.click(confirm());
    expect(onConfirm.mock.calls[0][0].goals).toHaveLength(2);
  });
});
