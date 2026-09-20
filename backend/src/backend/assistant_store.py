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

import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Literal

from backend.schemas import Proposal

MAX_CONVERSATIONS = 50
MAX_MESSAGES = 20
MAX_PROPOSALS = 200

ProposalStatus = Literal["pending", "accepted", "rejected"]


@dataclass
class Conversation:
    """One chat. `asked` is the text behind each question the Assistant left open."""

    conversation_id: str
    messages: list[str] = field(default_factory=list)
    # assistant message_id -> the user text that message's questions were asked about.
    asked: "OrderedDict[str, str]" = field(default_factory=OrderedDict)

    def remember(self, text: str) -> None:
        self.messages.append(text)
        del self.messages[:-MAX_MESSAGES]

    def leave_open(self, message_id: str, text: str) -> None:
        self.asked[message_id] = text
        while len(self.asked) > MAX_MESSAGES:
            self.asked.popitem(last=False)


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
    return conv.asked.get(message_id)


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
