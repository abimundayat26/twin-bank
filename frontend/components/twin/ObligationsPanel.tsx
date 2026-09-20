/**
 * The obligations TwinBank detected, grouped, with its open questions inline.
 *
 * This is the editing surface, so it belongs on Plans & Assistant: answering a
 * classification question changes a declared fact. The Overview summarises the
 * same grouping without the controls.
 */

import { money, ordinalDay, percent } from "@/lib/format";
import { groupObligations, needsAnswer } from "@/lib/obligations";
import type { FinancialObligation, FinancialTwin, ObligationCategory } from "@/lib/types";
import { CATEGORY_LABELS, CategoryQuestion } from "../CategoryQuestion";
import { Badge, Card, ProvenanceTag, Row } from "../ui";
import type { ReactNode } from "react";

export function ObligationsPanel({
  twin,
  isBusy = false,
  isOffline = false,
  savingScope,
  onAnswer,
}: {
  twin: FinancialTwin;
  /** A twin update is in flight somewhere on the page; no second one may start. */
  isBusy?: boolean;
  isOffline?: boolean;
  /** Which control started it. Forwarded: each control knows its own scope. */
  savingScope?: string;
  onAnswer: (obligationId: string, category: ObligationCategory) => void;
}) {
  const { upcoming, recurring, excluded } = groupObligations(twin);

  function obligationRow(obligation: FinancialObligation, meta: ReactNode) {
    if (needsAnswer(obligation)) {
      return (
        <CategoryQuestion
          key={obligation.id}
          obligation={obligation}
          isBusy={isBusy}
          isOffline={isOffline}
          savingScope={savingScope}
          onAnswer={(category) => onAnswer(obligation.id, category)}
        />
      );
    }
    return (
      <Row
        key={obligation.id}
        label={obligation.name}
        hint={`Due the ${ordinalDay(obligation.due_day)} · ${percent(obligation.confidence)} confidence`}
        value={money(obligation.expected_amount)}
        meta={meta}
      />
    );
  }

  return (
    <div className="grid gap-4">
      <Card title="Upcoming obligations" subtitle="Mandatory bills TwinBank must cover">
        <ul>
          {upcoming.map((obligation) =>
            obligationRow(obligation, <ProvenanceTag provenance={obligation.provenance} />),
          )}
        </ul>
      </Card>

      <Card title="Recurring expenses" subtitle="Recurring but not mandatory">
        <ul>
          {recurring.map((obligation) =>
            obligationRow(
              obligation,
              <Badge tone="caution">
                {obligation.declared_category
                  ? CATEGORY_LABELS[obligation.declared_category]
                  : "Optional"}
              </Badge>,
            ),
          )}
        </ul>
      </Card>

      {excluded.length > 0 ? (
        <Card title="Left out of the projection" subtitle="You said these do not recur">
          <ul>
            {excluded.map((obligation) => obligationRow(obligation, <Badge>Not recurring</Badge>))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
