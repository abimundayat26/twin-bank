import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import mockTwin from "@/lib/mock/twin.json";
import type {
  AssistantMessageResponse,
  AssistantQuestion,
  FinancialTwin,
  Proposal,
} from "@/lib/types";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getTwin: vi.fn(),
    getAssistantOpening: vi.fn(),
    sendAssistantMessage: vi.fn(),
    decideProposal: vi.fn(),
    respondToClarification: vi.fn(),
  };
});

import * as api from "@/lib/api";
import { OFFLINE_REASON } from "@/lib/offline";
import { TwinProvider } from "@/lib/state/TwinProvider";
import { AssistantChat } from "./AssistantChat";

const TWIN = mockTwin as unknown as FinancialTwin;

const OPENING_QUESTION: AssistantQuestion = {
  question_id: "q_transfer",
  text: "What is Online Transfer To ***4471 ($50 a month)?",
  field: "category",
  choices: ["Savings transfer", "Debt repayment"],
  fragment: "Online Transfer To ***4471",
};

const GOAL_PROPOSAL: Proposal = {
  proposal_id: "prop_trip",
  status: "pending",
  source_fragment: "save $2,000 for a trip by next June",
  requires_user_confirmation: true,
  action_type: "ADD_GOAL",
  goal: {
    id: "goal_trip",
    name: "Trip",
    target_amount: 2000,
    deadline: "2027-06-01",
    current_amount: 0,
    provenance: "declared",
  },
};

/** The shape every /assistant/message answer has; each test varies one part. */
function reply(overrides: Partial<AssistantMessageResponse> = {}): AssistantMessageResponse {
  return {
    conversation_id: "conv_1",
    message_id: "msg_1",
    reply: "Here is what I understood. Nothing changes until you accept.",
    read_by: "rules",
    proposals: [],
    questions: [],
    simulate_prefill: null,
    unparsed: [],
    ...overrides,
  };
}

function renderChat() {
  return render(
    <TwinProvider>
      <AssistantChat />
    </TwinProvider>,
  );
}

/** Waits for the twin to arrive, so the chat is past its loading state. */
async function chatReady() {
  renderChat();
  await screen.findByLabelText("Message the Assistant");
}

async function send(text: string) {
  const box = screen.getByLabelText("Message the Assistant");
  await userEvent.type(box, text);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.getAssistantOpening).mockResolvedValue({ questions: [] });
  vi.mocked(api.sendAssistantMessage).mockResolvedValue(reply());
  vi.mocked(api.respondToClarification).mockResolvedValue({ data: TWIN, source: "api" });
});

describe("AssistantChat opening (PL-1)", () => {
  it("opens with the one-line prompt when nothing is unclassified", async () => {
    await chatReady();
    expect(
      await screen.findByText("Tell me a goal, a limit, a bill, or a what-if."),
    ).toBeInTheDocument();
  });

  it("answers an opening question through the clarification route, not a card", async () => {
    vi.mocked(api.getAssistantOpening).mockResolvedValue({ questions: [OPENING_QUESTION] });
    await chatReady();

    await userEvent.click(await screen.findByRole("button", { name: "Savings transfer" }));

    expect(api.respondToClarification).toHaveBeenCalledWith(TWIN, {
      user_id: "alex",
      obligation_id: "obl_online_transfer_to",
      category: "savings_transfer",
    });
    // Answering it is not a draft: nothing is proposed and nothing waits for Accept.
    expect(api.sendAssistantMessage).not.toHaveBeenCalled();
    expect(await screen.findByText("Answered: Savings transfer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Savings transfer" })).not.toBeInTheDocument();
  });
});

describe("AssistantChat reading a message (PL-2, PL-3)", () => {
  it("shows the reply, who read it, and the draft it produced", async () => {
    vi.mocked(api.sendAssistantMessage).mockResolvedValue(reply({ proposals: [GOAL_PROPOSAL] }));
    await chatReady();

    await send("I want to save $2,000 for a trip by next June");

    expect(api.sendAssistantMessage).toHaveBeenCalledWith({
      user_id: "alex",
      text: "I want to save $2,000 for a trip by next June",
      conversation_id: null,
      in_reply_to: null,
    });
    expect(
      await screen.findByText("Here is what I understood. Nothing changes until you accept."),
    ).toBeInTheDocument();
    expect(screen.getByText("Read by rules")).toBeInTheDocument();
    expect(screen.getByText("Add goal: Trip, $2,000 by Jun 1, 2027")).toBeInTheDocument();
    // The quote on the card is the user's own words, so the reading can be
    // checked against the message above it (V1).
    const card = screen.getByRole("article");
    expect(within(card).getByText(/save \$2,000 for a trip by next June/)).toBeInTheDocument();
  });

  it("never labels a rules reading as a model's (AS-4)", async () => {
    vi.mocked(api.sendAssistantMessage).mockResolvedValue(reply({ read_by: "model" }));
    await chatReady();

    await send("put away around two thousand for spring break");

    expect(await screen.findByText("Read by model")).toBeInTheDocument();
    expect(screen.queryByText("Read by rules")).not.toBeInTheDocument();
  });

  it("sends on Enter and keeps Shift+Enter for a newline (PL-2)", async () => {
    await chatReady();
    const box = screen.getByLabelText("Message the Assistant");

    await userEvent.type(box, "first line{Shift>}{Enter}{/Shift}second line");
    expect(api.sendAssistantMessage).not.toHaveBeenCalled();
    expect(box).toHaveValue("first line\nsecond line");

    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(api.sendAssistantMessage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.sendAssistantMessage).mock.calls[0][0].text).toBe(
      "first line\nsecond line",
    );
  });

  it("carries the conversation id into the next message", async () => {
    await chatReady();
    await send("keep at least $1,500 in the bank for emergencies");
    await waitFor(() => expect(api.sendAssistantMessage).toHaveBeenCalledTimes(1));

    await send("what if I buy a $800 laptop");
    await waitFor(() => expect(api.sendAssistantMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.sendAssistantMessage).mock.calls[1][0].conversation_id).toBe("conv_1");
  });

  it("shows the backend's own message when a send fails (G-9)", async () => {
    vi.mocked(api.sendAssistantMessage).mockRejectedValue(
      new api.ApiError("That question has expired. Please type the full request again.", 422),
    );
    await chatReady();

    await send("June 1");

    expect(
      await screen.findByText("That question has expired. Please type the full request again."),
    ).toBeInTheDocument();
  });
});

describe("AssistantChat send limits (AS-13)", () => {
  it("will not send empty or whitespace-only text", async () => {
    await chatReady();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Message the Assistant"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("counts from 1,800 characters and refuses to send over 2,000", async () => {
    await chatReady();
    const box = screen.getByLabelText("Message the Assistant");

    fireEvent.change(box, { target: { value: "a".repeat(1800) } });
    expect(screen.getByText("1800 / 2000 characters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();

    fireEvent.change(box, { target: { value: "a".repeat(2001) } });
    expect(screen.getByText("2001 / 2000 characters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("disables the box while a message is in flight", async () => {
    let answer: (value: AssistantMessageResponse) => void = () => {};
    vi.mocked(api.sendAssistantMessage).mockReturnValue(
      new Promise<AssistantMessageResponse>((resolve) => {
        answer = resolve;
      }),
    );
    await chatReady();

    await send("I want to get a car");

    const box = screen.getByLabelText("Message the Assistant");
    expect(box).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reading…" })).toBeDisabled();

    answer(reply());
    await waitFor(() => expect(box).toBeEnabled());
  });
});

describe("AssistantChat deciding a draft (PL-5)", () => {
  beforeEach(() => {
    vi.mocked(api.sendAssistantMessage).mockResolvedValue(reply({ proposals: [GOAL_PROPOSAL] }));
  });

  it("accepts through the decision route and says what happened", async () => {
    const updated = { ...TWIN, goals: [...TWIN.goals] };
    vi.mocked(api.decideProposal).mockResolvedValue({
      proposal_id: "prop_trip",
      status: "accepted",
      twin: updated,
    });
    await chatReady();
    await send("I want to save $2,000 for a trip by next June");

    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));

    expect(api.decideProposal).toHaveBeenCalledWith("prop_trip", { decision: "accept" });
    expect(await screen.findByText("Added")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("rejects without touching the twin", async () => {
    vi.mocked(api.decideProposal).mockResolvedValue({
      proposal_id: "prop_trip",
      status: "rejected",
      twin: null,
    });
    await chatReady();
    await send("I want to save $2,000 for a trip by next June");

    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));

    expect(await screen.findByText("Dismissed")).toBeInTheDocument();
  });

  it("sends one decision however often the button is pressed (G-15)", async () => {
    let answer: () => void = () => {};
    vi.mocked(api.decideProposal).mockReturnValue(
      new Promise((resolve) => {
        answer = () =>
          resolve({ proposal_id: "prop_trip", status: "accepted", twin: TWIN });
      }),
    );
    await chatReady();
    await send("I want to save $2,000 for a trip by next June");

    const accept = await screen.findByRole("button", { name: "Accept" });
    await userEvent.click(accept);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();

    answer();
    await screen.findByText("Added");
    expect(api.decideProposal).toHaveBeenCalledTimes(1);
  });

  it("shows a 409 verbatim and offers to ask again (PL-5, G-16)", async () => {
    vi.mocked(api.decideProposal).mockRejectedValue(
      new api.ApiError("That no longer applies. Ask again.", 409),
    );
    await chatReady();
    await send("I want to save $2,000 for a trip by next June");

    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));

    expect(await screen.findByText("That no longer applies. Ask again.")).toBeInTheDocument();
    // The stale twin is refetched so the rest of the page stops showing it.
    await waitFor(() => expect(api.getTwin).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole("button", { name: "Ask again" }));
    expect(screen.getByLabelText("Message the Assistant")).toHaveFocus();
  });
});

describe("AssistantChat questions and what-ifs (PL-6, PL-7)", () => {
  it("answers a question with choices by quoting the message it answers", async () => {
    const question: AssistantQuestion = {
      question_id: "q_which",
      text: "Which one do you mean: Verizon Wireless or Spotify Premium?",
      field: "which_one",
      choices: ["Verizon Wireless", "Spotify Premium"],
      fragment: "my phone bill",
    };
    vi.mocked(api.sendAssistantMessage).mockResolvedValueOnce(reply({ questions: [question] }));
    await chatReady();
    await send("pay off my phone bill");

    await userEvent.click(await screen.findByRole("button", { name: "Verizon Wireless" }));

    await waitFor(() => expect(api.sendAssistantMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.sendAssistantMessage).mock.calls[1][0]).toMatchObject({
      text: "Verizon Wireless",
      in_reply_to: "msg_1",
    });
  });

  it("says what a free-text answer is answering, and lets it be cancelled", async () => {
    const question: AssistantQuestion = {
      question_id: "q_deadline",
      text: "When do you need it by? Please give a date.",
      field: "deadline",
      choices: [],
      fragment: "next summer",
    };
    vi.mocked(api.sendAssistantMessage).mockResolvedValueOnce(reply({ questions: [question] }));
    await chatReady();
    await send("put away two thousand sometime next summer");

    expect(
      await screen.findByText("Answering: When do you need it by? Please give a date."),
    ).toBeInTheDocument();

    await send("2027-06-01");
    await waitFor(() => expect(api.sendAssistantMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.sendAssistantMessage).mock.calls[1][0].in_reply_to).toBe("msg_1");

    // The next message is a new one: nothing is merged without in_reply_to (AS-11).
    await send("keep at least $1,500 for emergencies");
    await waitFor(() => expect(api.sendAssistantMessage).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.sendAssistantMessage).mock.calls[2][0].in_reply_to).toBeNull();
  });

  it("drops the answering state when Cancel is pressed", async () => {
    const question: AssistantQuestion = {
      question_id: "q_amount",
      text: "How much is the car?",
      field: "amount",
      choices: [],
      fragment: "a car",
    };
    vi.mocked(api.sendAssistantMessage).mockResolvedValueOnce(reply({ questions: [question] }));
    await chatReady();
    await send("I want to get a car");

    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/^Answering:/)).not.toBeInTheDocument();

    await send("$12,000");
    await waitFor(() => expect(api.sendAssistantMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.sendAssistantMessage).mock.calls[1][0].in_reply_to).toBeNull();
  });

  it("hands a what-if to the Simulator filled in, and runs nothing (PL-6, AS-8)", async () => {
    vi.mocked(api.sendAssistantMessage).mockResolvedValue(
      reply({
        reply: "That sounds like a what-if. I've filled in the Purchase Simulator for you.",
        simulate_prefill: { description: "Laptop", amount: 800, date: null },
      }),
    );
    await chatReady();

    await send("what if I buy a $800 laptop");

    const link = await screen.findByRole("link", { name: "Open in Purchase Simulator" });
    expect(link).toHaveAttribute("href", "/simulate?description=Laptop&amount=800");
    // Nothing on this page may state a probability or an affordability verdict.
    expect(screen.queryByText(/afford/i)).not.toBeInTheDocument();
  });
});

describe("AssistantChat offline (G-10, G-14)", () => {
  it("asks nothing, sends nothing, and says why", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "fixture" });
    renderChat();

    const box = await screen.findByLabelText("Message the Assistant");
    expect(api.getAssistantOpening).not.toHaveBeenCalled();
    expect(box).toBeDisabled();
    // AppShell carries the banner; every control here says the same reason.
    expect(box).toHaveAttribute("title", OFFLINE_REASON);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});

describe("AssistantChat transcript (PL-8)", () => {
  it("keeps the conversation in memory only, so a remount starts fresh", async () => {
    const { unmount } = render(
      <TwinProvider>
        <AssistantChat />
      </TwinProvider>,
    );
    await screen.findByLabelText("Message the Assistant");
    await send("I want to save $2,000 for a trip by next June");
    await screen.findByText("Here is what I understood. Nothing changes until you accept.");
    unmount();

    renderChat();
    const log = await screen.findByRole("log", { name: "Assistant conversation" });
    expect(
      within(log).queryByText("I want to save $2,000 for a trip by next June"),
    ).not.toBeInTheDocument();
    expect(
      within(log).getByText("Tell me a goal, a limit, a bill, or a what-if."),
    ).toBeInTheDocument();
  });
});
