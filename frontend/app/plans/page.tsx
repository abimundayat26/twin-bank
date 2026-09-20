"use client";

/**
 * Plans & Assistant: one conversation, and the declared plan it writes into.
 *
 * The layout is the chat with a Goals & Limits side-panel beside it
 * (frontend/SPEC.md section 9.2). Goals are created by typing a sentence and
 * accepting a card — nothing here declares one for the user, because a goal is
 * the one thing banking history can never establish (root SPEC.md section 2).
 * The panel is for correcting what is already declared.
 *
 * Obligations used to share this page. They have their own route now
 * (`/obligations`), so this page holds the two things that belong together: the
 * words the user types, and the plan those words become.
 */

import { AssistantChat } from "@/components/assistant/AssistantChat";
import { GoalsLimitsPanel } from "@/components/GoalsLimitsPanel";
import { Card, PageFrame, PageHeading } from "@/components/ui";
import { useTwin } from "@/lib/state/TwinProvider";

export default function PlansPage() {
  const { twin, twinError } = useTwin();

  if (twinError) {
    return (
      <PageFrame>
        <Card title="Could not load your plans">
          <p className="text-sm text-bad">{twinError}</p>
          <p className="mt-3 text-sm text-muted">
            Drafting a goal and saving one both need the backend. Until it answers, nothing
            on this page can be changed.
          </p>
        </Card>
      </PageFrame>
    );
  }

  if (!twin) {
    return (
      <PageFrame>
        <p className="text-sm text-muted">Loading Alex&rsquo;s plans…</p>
      </PageFrame>
    );
  }

  return (
    <PageFrame>
      <PageHeading title="Plans & Assistant">
        <p>
          Tell TwinBank a goal, a limit, a bill or a what-if. Nothing reaches{" "}
          {twin.display_name}&rsquo;s Financial Twin until it is accepted.
        </p>
      </PageHeading>

      {/* The chat takes the width it can get; the panel keeps a fixed column
          beside it from 1024px and collapses above it below that (section 9.2). */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <AssistantChat />
        </div>
        <GoalsLimitsPanel />
      </div>
    </PageFrame>
  );
}
