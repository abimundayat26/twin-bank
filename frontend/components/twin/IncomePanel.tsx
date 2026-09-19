/** Observed income streams and their cadence. Props only. */

import { longDate, money } from "@/lib/format";
import type { FinancialTwin } from "@/lib/types";
import { Card, ProvenanceTag, Row } from "../ui";

export function IncomePanel({ twin }: { twin: FinancialTwin }) {
  return (
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
  );
}
