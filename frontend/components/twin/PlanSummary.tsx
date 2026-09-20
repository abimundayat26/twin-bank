/**
 * The Overview's concise view of goals, obligations and open questions.
 *
 * Deliberately read-only and deliberately short: SPEC section 3.1 keeps the
 * goal compiler, the obligation editor and the full forms off this page, and
 * says the summaries must not embed them. Every path onward goes to Plans.
 */

import Link from "next/link";
import { longDate, money } from "@/lib/format";
import { groupObligations, openQuestions } from "@/lib/obligations";
import { byDueDate } from "@/lib/oneTimeObligations";
import { oneTimeObligations } from "@/lib/twin";
import type { FinancialTwin } from "@/lib/types";
import { Badge, Card, ProvenanceTag, Row } from "../ui";

function PlansLink({ children }: { children: React.ReactNode }) {
  return (
    <Link
      href="/plans"
      className="text-baseline underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-baseline"
    >
      {children}
    </Link>
  );
}

export function GoalsSummary({ twin }: { twin: FinancialTwin }) {
  // Soonest first: that deadline is where the simulation ends.
  const goals = [...twin.goals].sort((a, b) => a.deadline.localeCompare(b.deadline));

  return (
    <Card
      title="Savings goals"
      subtitle={goals.length === 1 ? "1 active goal" : `${goals.length} active goals`}
    >
      {goals.length > 0 ? (
        <ul>
          {goals.map((goal) => (
            <Row
              key={goal.id}
              label={goal.name}
              hint={`${money(goal.current_amount)} of ${money(goal.target_amount)} · by ${longDate(goal.deadline)}`}
              value={money(goal.target_amount)}
              meta={<ProvenanceTag provenance={goal.provenance} />}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          No goals declared. The simulation looks 180 days ahead.
        </p>
      )}
      <p className="mt-3 text-sm text-faint">
        <PlansLink>Add or change a goal</PlansLink> in Plans &amp; Assistant.
      </p>
    </Card>
  );
}

export function ObligationsSummary({ twin }: { twin: FinancialTwin }) {
  const { upcoming, recurring } = groupObligations(twin);
  const questions = openQuestions(twin);
  // Soonest in the month first, which is the order they will be paid in.
  const next = [...upcoming].sort((a, b) => a.due_day - b.due_day)[0];
  // Declared one-offs, read through the helper so a backend without the field
  // means "none" rather than a crash. Counted even at zero, so this page never
  // leaves the reader guessing whether it simply does not show them.
  const owed = byDueDate(oneTimeObligations(twin));

  return (
    <Card
      title="Upcoming obligations"
      subtitle={`${upcoming.length} mandatory · ${recurring.length} recurring · ${owed.length} one-time`}
    >
      {next ? (
        <Row
          label={next.name}
          hint="The next mandatory bill"
          value={money(next.expected_amount)}
          meta={<ProvenanceTag provenance={next.provenance} />}
        />
      ) : (
        <p className="text-sm text-muted">No mandatory bills detected.</p>
      )}

      {owed.length > 0 ? (
        // Its own block: a one-time obligation is already committed, so it sits
        // in the baseline — unlike the purchase the simulator asks about, and
        // unlike the recurring bills above, which TwinBank detected.
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            One-time, already committed
          </p>
          <ul>
            <Row
              label={owed[0].name}
              hint={`Due ${longDate(owed[0].due_date)}${owed[0].mandatory ? " · mandatory" : ""}`}
              value={money(owed[0].amount)}
              meta={<ProvenanceTag provenance={owed[0].provenance} />}
            />
          </ul>
          {owed.length > 1 ? (
            <p className="mt-2 text-sm text-faint">
              and {owed.length - 1} more in <PlansLink>Plans &amp; Assistant</PlansLink>.
            </p>
          ) : null}
        </div>
      ) : null}

      {questions.length > 0 ? (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Badge tone="caution">
            {questions.length === 1 ? "1 question" : `${questions.length} questions`}
          </Badge>
          <span>
            TwinBank could not classify {questions.length === 1 ? "a bill" : "some bills"} on its
            own. <PlansLink>Answer in Plans &amp; Assistant</PlansLink>.
          </span>
        </p>
      ) : (
        <p className="mt-3 text-sm text-faint">
          <PlansLink>Review obligations</PlansLink> in Plans &amp; Assistant.
        </p>
      )}
    </Card>
  );
}
