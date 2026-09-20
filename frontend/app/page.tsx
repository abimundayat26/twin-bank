"use client";

/**
 * Minimal Overview fed only by the backend-owned OverviewPayload (OV-1).
 * The page formats those values and turns spending amounts into display-only
 * donut geometry; it never rebuilds financial totals from the twin (G-6).
 */

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { Card, PageFrame } from "@/components/ui";
import { getOverview } from "@/lib/api";
import { chance, DateText, money, signedMoney } from "@/lib/format";
import mockOverview from "@/lib/mock/overview.json";
import { useTwin } from "@/lib/state/TwinProvider";
import type { OverviewPayload, SpendingSlice } from "@/lib/types";

const OFFLINE_OVERVIEW = mockOverview as OverviewPayload;
const DONUT_COLORS = ["#0a5ba8", "#c8102e", "#497ca8", "#9e1b2f", "#8ba8c4"];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-lg bg-raised ${className}`} />;
}

function OverviewSkeleton() {
  return (
    <PageFrame>
      <section role="status" aria-label="Loading overview" className="min-w-0">
        <span className="sr-only">Loading overview…</span>
        <SkeletonBlock className="mb-6 h-7 w-32" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <Card key={item} className="min-h-32">
              <SkeletonBlock className="h-4 w-3/4" />
              <SkeletonBlock className="mt-5 h-9 w-2/3" />
            </Card>
          ))}
        </div>
        <div className="mt-8">
          <SkeletonBlock className="mb-3 h-5 w-24" />
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1].map((item) => (
              <Card key={item} className="min-h-28">
                <SkeletonBlock className="h-4 w-2/3" />
                <SkeletonBlock className="mt-4 h-8 w-1/2" />
              </Card>
            ))}
          </div>
        </div>
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {[0, 1].map((item) => (
            <Card key={item} className="min-h-80">
              <SkeletonBlock className="h-full min-h-64 w-full" />
            </Card>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}

function ErrorCard({ message, retry }: { message: string; retry: () => void }) {
  return (
    <PageFrame>
      <h1 className="mb-6 text-lg font-semibold text-ink">Overview</h1>
      <Card title="Overview unavailable">
        <p role="alert" className="break-words text-sm text-bad">{message}</p>
        <button
          type="button"
          onClick={retry}
          className="mt-4 rounded-lg border border-counter px-4 py-2 text-sm font-semibold text-counter transition hover:bg-counter/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter"
        >
          Retry
        </button>
      </Card>
    </PageFrame>
  );
}

function KpiStrip({ overview }: { overview: OverviewPayload }) {
  return (
    <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-3">
      <Card className="min-h-32">
        <p className="text-sm font-medium text-muted">Total net balance</p>
        <p className="tnum mt-4 break-words text-3xl font-semibold text-ink">
          {money(overview.total_balance)}
        </p>
      </Card>
      <Card className="min-h-32">
        <p className="text-sm font-medium text-muted">Income minus fixed bills</p>
        <p className="tnum mt-4 break-words text-3xl font-semibold text-ink">
          {signedMoney(overview.monthly_net_cash_flow)}
        </p>
        <p className="mt-2 text-sm text-faint">Variable spending excluded</p>
      </Card>
      <Card className="min-h-32">
        <p className="text-sm font-medium text-muted">Goal progress</p>
        {overview.goal_progress == null ? (
          <Link
            href="/plans"
            className="mt-4 inline-flex text-sm font-semibold text-counter underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-counter"
          >
            No goals yet
          </Link>
        ) : (
          <p className="tnum mt-4 text-3xl font-semibold text-ink">
            {chance(overview.goal_progress)}
          </p>
        )}
      </Card>
    </section>
  );
}

function Accounts({ overview }: { overview: OverviewPayload }) {
  return (
    <section aria-labelledby="accounts-heading" className="mt-8 min-w-0">
      <h2 id="accounts-heading" className="mb-3 text-base font-semibold text-ink">Accounts</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {overview.accounts.map((account) => (
          <Card key={account.id} className="min-h-28">
            <p className="break-words text-sm font-medium text-muted" title={account.name}>
              {account.name}
            </p>
            <p className="tnum mt-4 break-words text-2xl font-semibold text-ink">
              {money(account.balance)}
            </p>
          </Card>
        ))}
      </div>
    </section>
  );
}

function donutBackground(spending: SpendingSlice[], total: number): CSSProperties {
  if (total <= 0 || spending.length === 0) return { background: "var(--color-raised)" };
  let start = 0;
  const stops = spending.map((slice, index) => {
    const end = Math.min(100, start + (slice.monthly_amount / total) * 100);
    const stop = `${DONUT_COLORS[index % DONUT_COLORS.length]} ${start}% ${end}%`;
    start = end;
    return stop;
  });
  if (start < 100) stops.push(`var(--color-raised) ${start}% 100%`);
  return { background: `conic-gradient(${stops.join(", ")})` };
}

function Spending({ overview }: { overview: OverviewPayload }) {
  const spending = overview.spending ?? [];
  return (
    <Card title="Spending" className="min-h-80 min-w-0">
      {spending.length === 0 ? (
        <p className="text-sm text-muted">No spending to show.</p>
      ) : (
        <>
          <div className="grid min-w-0 gap-6 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
            <div
              aria-hidden="true"
              className="relative mx-auto aspect-square w-48 shrink-0 rounded-full"
              style={donutBackground(spending, overview.total_monthly_spending)}
            >
              <div className="absolute inset-[23%] flex items-center justify-center rounded-full bg-surface px-2 text-center">
                <div>
                  <p className="tnum break-words text-lg font-semibold text-ink">
                    {money(overview.total_monthly_spending)}
                  </p>
                  <p className="text-sm text-muted">per month</p>
                </div>
              </div>
            </div>
            <ol aria-label="Spending legend" className="min-w-0 space-y-3">
              {spending.map((slice, index) => (
                <li key={`${slice.label}-${index}`} className="flex min-w-0 items-start gap-3 text-sm">
                  <span
                    aria-hidden="true"
                    className="mt-1 h-3 w-3 shrink-0 rounded-full border border-ink/20"
                    style={{ backgroundColor: DONUT_COLORS[index % DONUT_COLORS.length] }}
                  />
                  <span className="min-w-0 flex-1 break-words text-ink" title={slice.label}>
                    {slice.label}
                  </span>
                  <span className="tnum shrink-0 text-ink">{money(slice.monthly_amount)}</span>
                </li>
              ))}
            </ol>
          </div>
          <table className="sr-only" aria-label="Spending breakdown">
            <caption>Monthly spending values shown in the donut chart</caption>
            <thead><tr><th scope="col">Category</th><th scope="col">Monthly amount</th></tr></thead>
            <tbody>
              {spending.map((slice, index) => (
                <tr key={`${slice.label}-${index}`}>
                  <th scope="row">{slice.label}</th>
                  <td>{money(slice.monthly_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

function Upcoming({ overview }: { overview: OverviewPayload }) {
  const upcoming = overview.upcoming ?? [];
  return (
    <Card title="Upcoming activity" className="min-h-80 min-w-0">
      {upcoming.length === 0 ? (
        <p className="text-sm text-muted">Nothing due in the next 30 days.</p>
      ) : (
        <ul>
          {upcoming.map((item, index) => (
            <li
              key={`${item.date}-${item.kind}-${item.name}-${index}`}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-b border-line py-3 first:pt-0 last:border-0 last:pb-0"
            >
              <p className="break-words text-sm text-ink" title={item.name}>{item.name}</p>
              <p className="tnum text-right text-sm font-medium text-ink">
                {signedMoney(item.amount)}
              </p>
              <p className="col-span-2 text-sm text-muted">
                <DateText date={item.date} asOf={overview.as_of} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function Home() {
  const { twin, twinError, isOffline } = useTwin();
  const userId = twin?.user_id;
  const [attempt, setAttempt] = useState(0);
  const [requestState, setRequestState] = useState<{
    userId: string;
    attempt: number;
    overview?: OverviewPayload;
    error?: string;
  }>();

  useEffect(() => {
    if (!userId || isOffline) return;
    let cancelled = false;
    getOverview(userId)
      .then((loaded) => {
        if (!cancelled) {
          setRequestState({ userId, attempt, overview: loaded.data });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRequestState({ userId, attempt, error: errorText(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [userId, isOffline, attempt]);

  const requestMatches = requestState?.userId === userId && requestState?.attempt === attempt;
  const overview = isOffline
    ? OFFLINE_OVERVIEW
    : requestMatches
      ? requestState.overview ?? null
      : null;
  const overviewError = !isOffline && requestMatches ? requestState.error : undefined;

  if (twinError) {
    return <ErrorCard message={twinError} retry={() => window.location.reload()} />;
  }

  if (overviewError) {
    return <ErrorCard message={overviewError} retry={() => setAttempt((value) => value + 1)} />;
  }

  if (!twin || !overview) return <OverviewSkeleton />;

  if (overview.accounts.length === 0) {
    return (
      <PageFrame>
        <Card><p className="text-sm text-muted">No accounts yet</p></Card>
      </PageFrame>
    );
  }

  return (
    <PageFrame>
      <h1 className="mb-6 text-lg font-semibold text-ink">Overview</h1>
      <KpiStrip overview={overview} />
      <Accounts overview={overview} />
      <div className="mt-8 grid min-w-0 gap-6 lg:grid-cols-2 lg:items-stretch">
        <Spending overview={overview} />
        <Upcoming overview={overview} />
      </div>
    </PageFrame>
  );
}
