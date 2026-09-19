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

  return (
    <Card
      title="Upcoming obligations"
      subtitle={`${upcoming.length} mandatory · ${recurring.length} recurring`}
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
