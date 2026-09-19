/**
 * What TwinBank found in the history: income cadence, recurring obligations,
 * the ones it could not classify, and the categories left as variable spending.
 * Props only.
 *
 * Read-only by design. The Plans page is where a classification is answered,
 * because answering one changes a declared fact (SPEC section 3.2); this panel
 * counts the open questions and links there.
 */

import Link from "next/link";
import { money, ordinalDay, percent } from "@/lib/format";
import { groupObligations, openQuestions } from "@/lib/obligations";
import type { FinancialTwin } from "@/lib/types";
import { CATEGORY_LABELS } from "../CategoryQuestion";
import { Badge, Card, ProvenanceTag, Row } from "../ui";

/** "Every 14 days" reads better than an interval nobody asked to see in days. */
function cadence(intervalDays: number): string {
  if (intervalDays === 1) return "Every day";
  if (intervalDays === 7) return "Weekly";
  if (intervalDays === 14) return "Every 14 days";
  if (intervalDays >= 28 && intervalDays <= 31) return "Monthly";
  return `Every ${intervalDays} days`;
}

function label(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

export function DetectedStructurePanel({ twin }: { twin: FinancialTwin }) {
  const { upcoming, recurring, excluded } = groupObligations(twin);
  const questions = openQuestions(twin);

  return (
    <Card
      title="Detected structure"
      subtitle="The repeating shapes TwinBank found, and what it could not settle"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wider text-faint">Income cadence</h3>
      {twin.income.length > 0 ? (
        <ul className="mb-4">
          {twin.income.map((stream) => (
            <Row
              key={stream.id}
              label={stream.source}
              hint={`${cadence(stream.interval_days)} · ±${money(stream.uncertainty)} per payment`}
              value={money(stream.expected_amount)}
              meta={<ProvenanceTag provenance={stream.provenance} />}
            />
          ))}
        </ul>
      ) : (
        <p className="mb-4 mt-1 text-sm text-muted">
          No repeating deposit was detected in the observed window.
        </p>
      )}

      <h3 className="text-xs font-semibold uppercase tracking-wider text-faint">
        Recurring obligations
      </h3>
      <ul className="mb-4">
        <Row
          label="Treated as mandatory"
          hint="Covered by every projection"
          value={`${upcoming.length}`}
        />
        <Row
          label="Recurring but optional"
          hint="Detected, not mandatory"
          value={`${recurring.length}`}
        />
        {excluded.length > 0 ? (
          <Row
            label="Left out"
            hint="You said these do not recur"
            value={`${excluded.length}`}
          />
        ) : null}
      </ul>

      <h3 className="text-xs font-semibold uppercase tracking-wider text-faint">
        Ambiguous classifications
      </h3>
      {questions.length > 0 ? (
        <>
          <p className="mb-1 mt-1 text-sm text-muted">
            {questions.length === 1
              ? "One detected payment could not be classified from its transactions alone."
              : `${questions.length} detected payments could not be classified from their transactions alone.`}{" "}
            TwinBank shows its candidates as possibilities, not as facts, and waits for your
            answer.
          </p>
          <ul className="mb-2">
            {questions.map((obligation) => {
              const candidates = obligation.category_candidates ?? [];
              return (
                <Row
                  key={obligation.id}
                  label={obligation.name}
                  hint={`Due the ${ordinalDay(obligation.due_day)} · possibly ${candidates
                    .map((c) => `${CATEGORY_LABELS[c.category]} (${percent(c.probability)})`)
                    .join(" or ")}`}
                  value={money(obligation.expected_amount)}
                  meta={<Badge tone="caution">Unanswered</Badge>}
                />
              );
            })}
          </ul>
          <Link
            href="/plans"
            className="text-sm font-medium text-counter underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter"
          >
            Answer these on Plans &amp; Assistant
          </Link>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted">
          Every detected obligation is either classified or answered. Nothing is waiting on you.
        </p>
      )}

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-faint">
        Variable spending
      </h3>
      {twin.variable_spending.length > 0 ? (
        <ul>
          {twin.variable_spending.map((bucket) => (
            <Row
              key={bucket.category}
              label={label(bucket.category)}
              hint={`± ${money(bucket.std_dev_14d)} std dev per 14 days`}
              value={`${money(bucket.mean_14d)} / 14d`}
              meta={<ProvenanceTag provenance={bucket.provenance} />}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-muted">
          No category was left as variable spending in this twin.
        </p>
      )}
    </Card>
  );
}
