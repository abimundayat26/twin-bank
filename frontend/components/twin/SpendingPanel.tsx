/** Variable spending, with its seasonal shape where the forecast found one. Props only. */

import { money } from "@/lib/format";
import { forecastSummary, seasonalSummary } from "@/lib/seasonal";
import type { FinancialTwin } from "@/lib/types";
import { SeasonalSparkline } from "../SeasonalSparkline";
import { Card, ProvenanceTag, Row } from "../ui";

export function SpendingPanel({ twin }: { twin: FinancialTwin }) {
  const currentMonth = Number(twin.as_of.slice(5, 7));
  return (
    <Card
      title="Variable spending"
      subtitle={twin.forecast ? forecastSummary(twin.forecast) : "Observed 14-day averages"}
    >
      <ul>
        {twin.variable_spending.map((bucket) => {
          // A flat or absent profile adds nothing: the row reads exactly as before.
          const seasonal = bucket.seasonal ? seasonalSummary(bucket.seasonal) : null;
          const spread = `± ${money(bucket.std_dev_14d)} std dev per 14 days`;
          const label = bucket.category[0].toUpperCase() + bucket.category.slice(1);
          return (
            <Row
              key={bucket.category}
              label={label}
              hint={seasonal ? `${spread} · ${seasonal}` : spread}
              value={`${money(bucket.mean_14d)} / 14d`}
              meta={
                <>
                  {bucket.seasonal && seasonal ? (
                    <SeasonalSparkline
                      profile={bucket.seasonal}
                      currentMonth={currentMonth}
                      label={`${label} spending by month: ${seasonal}`}
                    />
                  ) : null}
                  <ProvenanceTag provenance={bucket.provenance} />
                </>
              }
            />
          );
        })}
      </ul>
    </Card>
  );
}
