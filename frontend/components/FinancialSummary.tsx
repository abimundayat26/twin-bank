/** Renders the observed + declared facts of Alex's Financial Twin. Props only. */

import { money, moneyExact, longDate, ordinalDay, percent } from "@/lib/format";
import type { FinancialTwin } from "@/lib/types";
import { Badge, Card, ProvenanceTag, Row } from "./ui";

export function FinancialSummary({ twin }: { twin: FinancialTwin }) {
  const reserve = twin.constraints.find((c) => c.type === "minimum_reserve");
  const recurring = twin.obligations.filter((o) => !o.mandatory);
  const upcoming = twin.obligations.filter((o) => o.mandatory);

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
          {upcoming.map((obligation) => (
            <Row
              key={obligation.id}
              label={obligation.name}
              hint={`Due the ${ordinalDay(obligation.due_day)} · ${percent(obligation.confidence)} confidence`}
              value={money(obligation.expected_amount)}
              meta={<ProvenanceTag provenance={obligation.provenance} />}
            />
          ))}
        </ul>
      </Card>

      <Card title="Recurring expenses" subtitle="Recurring but not mandatory">
        <ul>
          {recurring.map((obligation) => (
            <Row
              key={obligation.id}
              label={obligation.name}
              hint={`Due the ${ordinalDay(obligation.due_day)} · ${percent(obligation.confidence)} confidence`}
              value={money(obligation.expected_amount)}
              meta={<Badge tone="caution">Optional</Badge>}
            />
          ))}
        </ul>
      </Card>

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
    </div>
  );
}
