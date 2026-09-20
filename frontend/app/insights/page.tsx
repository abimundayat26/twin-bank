"use client";

import { useCallback, useEffect, useState } from "react";

import { ForecastChart } from "@/components/insights/ForecastChart";
import { Badge, Card, PageFrame, PageHeading, Row } from "@/components/ui";
import { getForecast, type Loaded } from "@/lib/api";
import { DateText, money, ordinalDay, roundHalfAwayFromZero } from "@/lib/format";
import { useTwin } from "@/lib/state/TwinProvider";
import type { FinancialTwin, ForecastPayload } from "@/lib/types";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function sourceLabel(source: FinancialTwin["source"]): string {
  if (source === "fixture") return "Sample data";
  if (source === "nessie") return "Capital One Nessie";
  if (source === "databricks") return "Processed in Databricks";
  return "Unavailable";
}

function lineageLabel(twin: FinancialTwin): string | null {
  if (!twin.lineage) return null;
  const where = twin.lineage.location === "databricks" ? "in Databricks" : "locally";
  const status = twin.lineage.status === "succeeded"
    ? "succeeded"
    : twin.lineage.status === "failed"
      ? "failed"
      : "status unknown";
  return `Processed ${where}, ${status}`;
}

function SeasonalTrends({ twin }: { twin: FinancialTwin }) {
  const trends = twin.variable_spending.flatMap((category) => {
    if (!category.seasonal) return [];
    const factors = Object.entries(category.seasonal.factors)
      .map(([month, factor]) => ({ month: Number(month), factor }))
      .filter(({ month, factor }) => month >= 1 && month <= 12 && Number.isFinite(factor));
    if (!factors.length) return [];
    const busiest = factors.reduce((best, item) => item.factor > best.factor ? item : best);
    const quietest = factors.reduce((best, item) => item.factor < best.factor ? item : best);
    return [{ category: category.category, busiest, quietest }];
  });

  return (
    <Card title="Seasonal trends">
      {trends.length ? (
        <ul className="space-y-3 text-sm text-ink">
          {trends.map(({ category, busiest, quietest }) => (
            <li key={category} className="break-words">
              <span>{category.charAt(0).toUpperCase() + category.slice(1)}</span> runs busiest in{" "}
              {MONTHS[busiest.month - 1]} (+{roundHalfAwayFromZero((busiest.factor - 1) * 100)}%)
              {" "}and quietest in {MONTHS[quietest.month - 1]} (−
              {Math.abs(roundHalfAwayFromZero((quietest.factor - 1) * 100))}%).
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">No seasonal pattern found yet.</p>}
    </Card>
  );
}

function LoadingPage() {
  return (
    <div aria-label="Loading Forecast & Data" className="grid animate-pulse gap-4 lg:grid-cols-3">
      {[0, 1, 2].map((item) => (
        <div key={item} className="h-40 rounded-xl border border-line bg-surface" />
      ))}
    </div>
  );
}

function LoadingForecast() {
  return (
    <div
      aria-label="Loading forecast"
      className="h-96 animate-pulse rounded-xl border border-line bg-surface"
    />
  );
}

export default function ForecastPage() {
  const { twin, twinError } = useTwin();
  const [forecast, setForecast] = useState<Loaded<ForecastPayload> | null>(null);
  const [forecastTwin, setForecastTwin] = useState<FinancialTwin | null>(null);
  const [forecastError, setForecastError] = useState<string>();
  const [forecastErrorTwin, setForecastErrorTwin] = useState<FinancialTwin | null>(null);
  const [requestKey, setRequestKey] = useState(0);
  const retry = useCallback(() => {
    setForecast(null);
    setForecastTwin(null);
    setForecastError(undefined);
    setForecastErrorTwin(null);
    setRequestKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (!twin) return;
    let cancelled = false;
    getForecast(twin.user_id)
      .then((loaded) => {
        if (!cancelled) {
          setForecast(loaded);
          setForecastTwin(twin);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setForecastError(error instanceof Error ? error.message : String(error));
          setForecastErrorTwin(twin);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [twin, requestKey]);

  if (twinError) {
    return (
      <PageFrame>
        <Card title="Could not load Forecast & Data">
          <p className="text-sm text-bad">{twinError}</p>
        </Card>
      </PageFrame>
    );
  }
  if (!twin) return <PageFrame><LoadingPage /></PageFrame>;

  const processed = lineageLabel(twin);
  const visibleForecast = forecastTwin === twin ? forecast : null;
  const visibleForecastError = forecastErrorTwin === twin ? forecastError : undefined;
  const activeBills = twin.obligations
    .filter((item) => item.active !== false)
    .sort((a, b) => a.due_day - b.due_day);

  return (
    <PageFrame>
      <PageHeading title="Forecast & Data">
        <p>See what shaped {twin.display_name}&rsquo;s financial twin and its baseline projection.</p>
      </PageHeading>

      <section className="mb-8" aria-labelledby="sources-heading">
        <h2 id="sources-heading" className="mb-3 text-base font-semibold text-ink">
          Linked accounts &amp; sources
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {twin.accounts.length ? twin.accounts.map((account) => (
            <Card key={account.id} title={account.name}>
              <p className="text-sm capitalize text-muted">{account.type}</p>
              <p className="mt-2 tnum text-xl font-semibold text-ink">{money(account.balance)}</p>
            </Card>
          )) : <Card><p className="text-sm text-muted">No linked accounts yet.</p></Card>}
          <Card title="Data source">
            <p className="text-sm font-medium text-ink">{sourceLabel(twin.source)}</p>
            {processed ? <p className="mt-2 text-sm text-muted">{processed}</p> : null}
          </Card>
        </div>
      </section>

      <section className="mb-8" aria-labelledby="structure-heading">
        <h2 id="structure-heading" className="mb-3 text-base font-semibold text-ink">
          Financial structure
        </h2>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Income cadence">
            {twin.income.length ? <ul>{twin.income.map((stream) => (
              <Row
                key={stream.id}
                label={stream.source}
                value={`${money(stream.expected_amount)} every ${stream.interval_days} days`}
                meta={<span className="text-xs text-muted">Next: <DateText date={stream.next_date} asOf={twin.as_of} /></span>}
              />
            ))}</ul> : <p className="text-sm text-muted">No income cadence detected yet.</p>}
          </Card>
          <Card title="Fixed bill schedule">
            {activeBills.length ? <ul>{activeBills.map((bill) => (
              <Row
                key={bill.id}
                label={bill.name}
                value={money(bill.expected_amount)}
                hint={`on the ${ordinalDay(bill.due_day)}`}
              />
            ))}</ul> : <p className="text-sm text-muted">No active recurring bills yet.</p>}
          </Card>
          <SeasonalTrends twin={twin} />
        </div>
      </section>

      <section aria-labelledby="forecast-heading">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 id="forecast-heading" className="text-base font-semibold text-ink">Forecast chart</h2>
          {visibleForecast?.data.is_mock ? <Badge>Sample figures</Badge> : null}
        </div>
        {visibleForecastError ? (
          <Card>
            <p className="text-sm text-bad">{visibleForecastError}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-3 rounded-md border border-line px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Retry
            </button>
          </Card>
        ) : !visibleForecast ? <LoadingForecast /> : (
          <Card>
            <p className="mb-3 text-xs text-faint">
              Through <DateText date={visibleForecast.data.horizon_end} asOf={twin.as_of} />
            </p>
            <ForecastChart
              bands={visibleForecast.data.bands}
              callouts={visibleForecast.data.callouts ?? []}
              asOf={twin.as_of}
            />
          </Card>
        )}
      </section>
    </PageFrame>
  );
}
