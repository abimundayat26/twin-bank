/** Renders the observed + declared facts of Alex's Financial Twin. Props only. */

import type { ReactNode } from "react";
import { money, moneyExact, longDate, ordinalDay, percent } from "@/lib/format";
import type { FinancialObligation, FinancialTwin, ObligationCategory } from "@/lib/types";
import { CATEGORY_LABELS, CategoryQuestion } from "./CategoryQuestion";
import { MinimumBalanceCard } from "./MinimumBalanceCard";
import { Badge, Card, ProvenanceTag, Row } from "./ui";

/** Alex's declared category overrides the bank's observed mandatory flag. */
function isMandatory(obligation: FinancialObligation): boolean {
  const declared = obligation.declared_category;
  if (declared === "bill" || declared === "debt_repayment") return true;
  if (declared) return false;
  return obligation.mandatory;
}

export function FinancialSummary({
  twin,
  isBusy = false,
  savingScope,
  onAnswer,
  onSetMinimum,
}: {
  twin: FinancialTwin;
  /** A twin update is in flight somewhere on the page; no second one may start. */
  isBusy?: boolean;
  /** Which control started it. Forwarded: each control knows its own scope. */
  savingScope?: string;
  onAnswer: (obligationId: string, category: ObligationCategory) => void;
  onSetMinimum: (amount: number) => void;
}) {
  const reserve = twin.constraints.find((c) => c.type === "minimum_reserve");
  const minimum = twin.constraints.find((c) => c.type === "minimum_checking_balance");
  // Declared "not recurring" obligations are left out of the simulation, so they are
  // listed separately rather than as recurring expenses.
  const excluded = twin.obligations.filter((o) => o.declared_category === "not_recurring");
  const recurring = twin.obligations.filter(
    (o) => !isMandatory(o) && o.declared_category !== "not_recurring",
  );
  const upcoming = twin.obligations.filter(isMandatory);

  function obligationRow(obligation: FinancialObligation, meta: ReactNode) {
    if (obligation.category_candidates?.length) {
      return (
        <CategoryQuestion
          key={obligation.id}
          obligation={obligation}
          isBusy={isBusy}
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
      <Card title="Current balance" subtitle={`As of ${longDate(twin.as_of)}`}>
        <p className="tnum text-4xl font-semibold text-ink">
          {moneyExact(twin.total_balance)}
        </p>
        <ul className="mt-4">
          {twin.accounts.map((account) => (
            <Row
              key={account.id}
              label={account.name}
              hint={account.type === "checking" ? "Checking" : "Savings"}
              value={moneyExact(account.balance)}
            />
          ))}
        </ul>
      </Card>

      <Card title="Expected income">
        <ul>
          {twin.income.map((stream) => (
            <Row
              key={stream.id}
              label={stream.source}
              hint={`Every ${stream.interval_days} days · next ${longDate(stream.next_date)} · ±${money(stream.uncertainty)}`}
              value={money(stream.expected_amount)}
              meta={<ProvenanceTag provenance={stream.provenance} />}
            />
          ))}
        </ul>
      </Card>

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
            {excluded.map((obligation) =>
              obligationRow(obligation, <Badge>Not recurring</Badge>),
            )}
          </ul>
        </Card>
      ) : null}

      <Card title="Variable spending" subtitle="Observed 14-day averages">
        <ul>
          {twin.variable_spending.map((bucket) => (
            <Row
              key={bucket.category}
              label={bucket.category[0].toUpperCase() + bucket.category.slice(1)}
              hint={`± ${money(bucket.std_dev_14d)} std dev per 14 days`}
              value={`${money(bucket.mean_14d)} / 14d`}
              meta={<ProvenanceTag provenance={bucket.provenance} />}
            />
          ))}
        </ul>
      </Card>

      {reserve ? (
        <Card title="Minimum emergency reserve">
          <div className="flex items-baseline justify-between gap-4">
            <p className="tnum text-3xl font-semibold text-ink">{money(reserve.amount)}</p>
            <ProvenanceTag provenance={reserve.provenance} />
          </div>
          <p className="mt-2 text-sm text-muted">{reserve.description}</p>
        </Card>
      ) : null}

      <MinimumBalanceCard
        key={minimum?.amount ?? "unset"}
        minimum={minimum}
        isBusy={isBusy}
        savingScope={savingScope}
        onSave={onSetMinimum}
      />
    </div>
  );
}
