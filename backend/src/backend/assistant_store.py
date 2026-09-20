"""Where the Assistant's conversations and open proposals live: process memory.

Nothing financial is kept here. Conversations hold what the user typed so an
answer to a question can be merged with the sentence it was asked about (AS-11),
and proposals are held so the user can accept one a moment later (AS-15). Both
are lost on restart, which `frontend/SPEC.md` AS-12 accepts explicitly: the twin
is the only thing that has to survive, and a proposal that vanished is a
suggestion the user has to make again, not money that moved.

Bounded on purpose. Fifty conversations, twenty messages each and two hundred
proposals is more than a demo can produce, and a hackathon server that runs for a
week must not grow without limit.
"""

import re
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Literal

from backend.schemas import AssistantQuestion, Proposal

MAX_CONVERSATIONS = 50
MAX_MESSAGES = 20
MAX_PROPOSALS = 200

ProposalStatus = Literal["pending", "accepted", "rejected"]


@dataclass
class Conversation:
    """One chat. `asked` is the text behind each question the Assistant left open."""

    conversation_id: str
    messages: list[str] = field(default_factory=list)
    # assistant message_id -> the text and questions produced from it.
    asked: "OrderedDict[str, OpenQuestions]" = field(default_factory=OrderedDict)

    def remember(self, text: str) -> None:
        self.messages.append(text)
        del self.messages[:-MAX_MESSAGES]

    def leave_open(
        self, message_id: str, text: str, questions: list[AssistantQuestion]
    ) -> None:
        self.asked[message_id] = OpenQuestions(text=text, questions=questions)
        while len(self.asked) > MAX_MESSAGES:
            self.asked.popitem(last=False)


@dataclass
class OpenQuestions:
    text: str
    questions: list[AssistantQuestion]


@dataclass
class StoredProposal:
    proposal: Proposal
    user_id: str
    status: ProposalStatus = "pending"


_conversations: "OrderedDict[str, Conversation]" = OrderedDict()
_proposals: "OrderedDict[str, StoredProposal]" = OrderedDict()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def conversation(conversation_id: str | None) -> Conversation:
    """The conversation with that id, created if it is new or has been evicted.

    An unknown id is not an error: the only thing lost with it is chat history, and
    the caller finds out through `text_behind` when it mattered (AS-11).
    """
    if conversation_id and conversation_id in _conversations:
        _conversations.move_to_end(conversation_id)
        return _conversations[conversation_id]
    fresh = Conversation(conversation_id=conversation_id or new_id("conv"))
    _conversations[fresh.conversation_id] = fresh
    while len(_conversations) > MAX_CONVERSATIONS:
        _conversations.popitem(last=False)
    return fresh


def text_behind(conv: Conversation, message_id: str) -> str | None:
    """What the user had written when `message_id` asked its questions, or None if
    that question is unknown or has expired (AS-11)."""
    open_questions = conv.asked.get(message_id)
    return open_questions.text if open_questions is not None else None


_DEADLINE_LEAD = re.compile(r"^(?:by|before|until|no later than|on|in|within)\b", re.I)
_BARE_NUMBER = re.compile(r"^[\d.,]+$")
_QUOTED = re.compile(r'"([^"]+)"')


def _question_for_answer(
    open_questions: OpenQuestions, answer: str
) -> AssistantQuestion:
    """Resolve the question selected by the UI's message-level `in_reply_to`.

    Choice answers identify their question directly. Free text answers the first
    free-text question, matching the frontend's composer behaviour.
    """
    said = answer.strip().casefold()
    for question in open_questions.questions:
        if any(said == choice.strip().casefold() for choice in question.choices):
            return question
    return next(
        (question for question in open_questions.questions if not question.choices),
        open_questions.questions[0],
    )


def _answered_fragment(question: AssistantQuestion, answer: str) -> tuple[str, str]:
    """Return (target, replacement) for the clause a question was about."""
    said = answer.strip()
    fragment = question.fragment.strip()
    if question.field == "deadline":
        # Vague dates are quoted in the deterministic question. Replace those words
        # instead of retaining them beside the answer and asking forever.
        quoted = _QUOTED.search(question.text)
        target = quoted.group(1) if quoted and quoted.group(1) in fragment else fragment
        replacement = said if _DEADLINE_LEAD.search(said) else f"by {said}"
        if target == fragment and target not in replacement:
            replacement = f"{fragment} {replacement}"
        return target, replacement
    if question.field == "amount":
        amount = f"${said}" if _BARE_NUMBER.fullmatch(said) else said
        replacement = (
            fragment.replace(" for ", f" {amount} for ", 1)
            if " for " in fragment
            else f"{fragment} {amount}"
        )
        return fragment, replacement
    if question.field == "name":
        named = said if said.lower().startswith("for ") else f"for {said}"
        return fragment, f"{fragment} {named}"
    if question.field == "account":
        lead = re.match(r"^(?:from|out of|using)\b", said, re.I)
        return fragment, f"{fragment} {said if lead else f'from {said}'}"
    if question.field == "mandatory":
        return fragment, f"{fragment}, {said}"
    if question.field in ("type", "intent"):
        return fragment, said
    return fragment, f"{fragment} {said}"


def merge_reply(conv: Conversation, message_id: str, answer: str) -> str | None:
    """Fold an explicit answer into the exact question fragment it addresses."""
    open_questions = conv.asked.get(message_id)
    if open_questions is None or not open_questions.questions:
        return None
    question = _question_for_answer(open_questions, answer)
    target, replacement = _answered_fragment(question, answer)
    at = open_questions.text.find(target)
    if at < 0:
        return f"{open_questions.text.rstrip(' .')}. {replacement}"
    return (
        open_questions.text[:at]
        + replacement
        + open_questions.text[at + len(target) :]
    )


def save_proposals(proposals: list[Proposal], user_id: str) -> None:
    for proposal in proposals:
        _proposals[proposal.proposal_id] = StoredProposal(proposal=proposal, user_id=user_id)
    while len(_proposals) > MAX_PROPOSALS:
        _proposals.popitem(last=False)


def get_proposal(proposal_id: str) -> StoredProposal | None:
    return _proposals.get(proposal_id)


def set_status(proposal_id: str, status: ProposalStatus) -> None:
    stored = _proposals.get(proposal_id)
    if stored is not None:
        stored.status = status
        stored.proposal = stored.proposal.model_copy(update={"status": status})


def reset() -> None:
    """Forget every conversation and proposal. Used between tests."""
    _conversations.clear()
    _proposals.clear()
