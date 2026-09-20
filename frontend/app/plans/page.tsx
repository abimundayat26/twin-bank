"use client";

/**
 * Plans & Assistant: everything Alex declares, and every question TwinBank has
 * to ask him.
 *
 * Goals, constraints and obligation classifications share this page because
 * each one depends on the user declaring or clarifying intent that banking
 * history alone cannot establish (SPEC section 3.2). Goals and obligations keep
 * visibly separate panels so combining the workflows does not turn them into
 * one undifferentiated list.
 *
 * One-time obligations are built here now that the contract exists: the compiler
 * drafts them, the review step below reads them back, and a confirmed one is
 * listed beside the detected recurring bills it must never be confused with.
 *
 * The TwinBank Assistant conversation is still specified but not built. This page
 * has the review-first workflow it describes, not the conversation layout.
 */

import { GoalCard } from "@/components/GoalCard";
import { GoalComposer } from "@/components/GoalComposer";
import { ConstraintsPanel } from "@/components/twin/ConstraintsPanel";
import { ObligationsPanel } from "@/components/twin/ObligationsPanel";
import { OneTimeObligationsPanel } from "@/components/twin/OneTimeObligationsPanel";
import { Card } from "@/components/ui";
import { openQuestions } from "@/lib/obligations";
import { useTwin } from "@/lib/state/TwinProvider";
import { oneTimeObligations } from "@/lib/twin";

export default function PlansPage() {
  const {
    twin,
    twinError,
    isBusy,
    savingScope,
    twinUpdateError,
    goalDraft,
    isCompilingGoal,
    goalCompileError,
    goalSaveError,
    composerKey,
    answerClarification,
    setMinimum,
    compileGoalText,
    confirmGoals,
    removeGoal,
    removeOneTimeObligation,
    discardGoalDraft,
  } = useTwin();

  if (twinError) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <Card title="Could not load your plans">
          <p className="text-sm text-bad">{twinError}</p>
          <p className="mt-3 text-sm text-muted">
            Compiling and saving a goal both need the backend. Until it answers, nothing on
            this page can be changed.
          </p>
        </Card>
      </main>
    );
  }

  if (!twin) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <p className="text-sm text-muted">Loading Alex&rsquo;s plans…</p>
      </main>
    );
  }

  // Soonest first: that deadline is where the simulation ends.
  const goals = [...twin.goals].sort((a, b) => a.deadline.localeCompare(b.deadline));
  const questions = openQuestions(twin);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-ink">Plans &amp; Assistant</h1>
        <p className="text-sm text-muted">
          What {twin.display_name} declared, and what TwinBank still needs to ask. Nothing
          here reaches the Financial Twin until it is confirmed.
        </p>
      </div>

      {twinUpdateError ? (
        <div className="mb-4">
          <Card title="Could not save your answer">
            <p className="text-sm text-bad">{twinUpdateError}</p>
          </Card>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        {/* Goals on one side, obligations on the other: two workflows, kept
            distinct even though they share a page (SPEC §3.2). */}
        <section aria-labelledby="goals-heading" className="grid gap-4">
          <h2 id="goals-heading" className="text-sm font-semibold uppercase tracking-wider text-muted">
            Goals and limits
          </h2>

          {goals.length > 0 ? (
            goals.map((goal, index) => (
              <GoalCard
                key={goal.id}
                goal={goal}
                title={index === 0 ? "Active savings goal" : "Also saving for"}
                subtitle={
                  index === 0 && goals.length > 1
                    ? "The soonest deadline, which is where the simulation ends."
                    : undefined
                }
                isBusy={isBusy}
                savingScope={savingScope}
                onRemove={removeGoal}
              />
            ))
          ) : (
            <Card title="Savings goals">
              <p className="text-sm text-muted">
                No goals declared. The simulation looks 180 days ahead.
              </p>
            </Card>
          )}

          <GoalComposer
            key={composerKey}
            goals={twin.goals}
            constraints={twin.constraints}
            owed={oneTimeObligations(twin)}
            accounts={twin.accounts}
            asOf={twin.as_of}
            draft={goalDraft}
            isCompiling={isCompilingGoal}
            isBusy={isBusy}
            savingScope={savingScope}
            compileError={goalCompileError}
            saveError={goalSaveError}
            onCompile={compileGoalText}
            onConfirm={confirmGoals}
            onDiscard={discardGoalDraft}
          />

          <ConstraintsPanel
            twin={twin}
            isBusy={isBusy}
            savingScope={savingScope}
            onSetMinimum={setMinimum}
          />
        </section>

        <section aria-labelledby="obligations-heading" className="grid gap-4">
          <h2
            id="obligations-heading"
            className="text-sm font-semibold uppercase tracking-wider text-muted"
          >
            Obligations
          </h2>

          {questions.length > 0 ? (
            <Card title="TwinBank needs your answer">
              <p className="text-sm text-muted">
                {questions.length === 1
                  ? "One detected bill could not be classified from its transactions alone."
                  : `${questions.length} detected bills could not be classified from their transactions alone.`}{" "}
                Your answer is a declared fact, so TwinBank asks rather than deciding for you.
              </p>
            </Card>
          ) : null}

          <ObligationsPanel
            twin={twin}
            isBusy={isBusy}
            savingScope={savingScope}
            onAnswer={answerClarification}
          />

          {/* Declared, one-off, already owed: kept below the detected recurring
              bills rather than mixed into them (SPEC §3.2). */}
          <OneTimeObligationsPanel
            twin={twin}
            isBusy={isBusy}
            savingScope={savingScope}
            onRemove={removeOneTimeObligation}
          />
        </section>
      </div>
    </main>
  );
}
