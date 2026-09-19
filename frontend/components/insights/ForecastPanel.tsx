/**
 * How the observed figures were estimated, and how spending moves through the
 * year. Props only.
 *
 * Two separate facts, deliberately not collapsed: `forecast` describes *how the
 * estimate was made*, and a category's `seasonal` profile is *part of the
 * estimate*. A twin can carry the second without the first — the demo fixture
 * does — so a missing forecast block must never be read as "no seasonality".
 */

import { longDate } from "@/lib/format";
import { monthFactors, seasonalSummary } from "@/lib/seasonal";
import type {
  FinancialTwin,
  ForecastMetadata,
  SeasonalProfile,
  VariableSpendingDistribution,
} from "@/lib/types";
import { SeasonalSparkline } from "../SeasonalSparkline";
import { Card, Row } from "../ui";

/** What each method actually did, without the identifier being the story. */
const METHODS: Record<ForecastMetadata["method"], { name: string; description: string }> = {
  flat_mean: {
    name: "Flat mean",
    description:
      "Every observed fortnight counted equally, with no seasonal adjustment: one average, applied to every month ahead.",
  },
  seasonal_ewma: {
    name: "Seasonal EWMA",
    description:
      "Recent fortnights counted more heavily than older ones, and each category carries a per-month profile on top of its average.",
  },
};

function weighting(forecast: ForecastMetadata): string {
  return forecast.half_life_days != null
    ? `An observation ${forecast.half_life_days} days old counts half as much as one from the last day of the window.`
    : "Every observation in the window counted equally, however old it is.";
}

function label(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/** A category's twelve factors, printed under its sparkline. */
function FactorGrid({ profile, currentMonth }: { profile: SeasonalProfile; currentMonth: number }) {
  return (
    <ul className="mt-2 grid grid-cols-6 gap-x-2 gap-y-1 sm:grid-cols-12">
      {monthFactors(profile).map(({ month, name, factor }) => (
        <li key={month} className="text-center">
          <span
            className={`block text-[10px] uppercase tracking-wide ${
              month === currentMonth ? "text-ink" : "text-faint"
            }`}
          >
            {name.slice(0, 3)}
          </span>
          <span className="tnum block text-[11px] text-muted">{factor.toFixed(2)}×</span>
        </li>
      ))}
    </ul>
  );
}

function SeasonalCategory({
  bucket,
  currentMonth,
}: {
  bucket: VariableSpendingDistribution;
  currentMonth: number;
}) {
  const profile = bucket.seasonal;
  // A profile whose months are all equal has no shape to describe.
  const summary = profile ? seasonalSummary(profile) : null;
  if (!profile || !summary) return null;
  return (
    <li className="border-b border-line/60 py-3 last:border-0">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm text-ink">{label(bucket.category)}</p>
        <SeasonalSparkline
          profile={profile}
          currentMonth={currentMonth}
          label={`${label(bucket.category)} spending by month: ${summary}`}
        />
      </div>
      <p className="text-xs text-faint">{summary}</p>
      <FactorGrid profile={profile} currentMonth={currentMonth} />
    </li>
  );
}

export function ForecastPanel({ twin }: { twin: FinancialTwin }) {
  const currentMonth = Number(twin.as_of.slice(5, 7));
  const forecast = twin.forecast;
  const method = forecast ? METHODS[forecast.method] : null;

  const shaped = twin.variable_spending.filter(
    (bucket) => bucket.seasonal && seasonalSummary(bucket.seasonal),
  );
  const flat = twin.variable_spending.filter(
    (bucket) => !bucket.seasonal || !seasonalSummary(bucket.seasonal),
  );

  return (
    <Card title="Forecast" subtitle="How the observed figures were estimated">
      {forecast && method ? (
        <>
          <p className="text-sm text-ink">{method.name}</p>
          <p className="mt-1 text-sm text-muted">{method.description}</p>
          <ul className="mt-3">
            <Row
              label="Observation window"
              value={`${longDate(forecast.window_start)} – ${longDate(forecast.as_of)}`}
            />
            <Row
              label="Fortnights observed"
              hint="14-day blocks the estimate is fitted to"
              value={`${forecast.observed_fortnights}`}
            />
            <Row
              label="Recency weighting"
              value={
                forecast.half_life_days != null
                  ? `${forecast.half_life_days}-day half-life`
                  : "Equal weight"
              }
            />
          </ul>
          <p className="mt-2 text-xs text-faint">{weighting(forecast)}</p>
        </>
      ) : (
        <>
          <p className="text-sm text-ink">No forecast metadata recorded for this twin.</p>
          <p className="mt-1 text-sm text-muted">
            This twin arrived with its observed figures already computed, so TwinBank cannot say
            which method produced them, what window they cover, or how heavily recent fortnights
            counted. Only a twin rebuilt from transactions records that. It does not mean the
            figures are unseasonal: any shape the twin carries is shown below.
          </p>
        </>
      )}

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-faint">
        Seasonal factors
      </h3>
      {shaped.length > 0 ? (
        <>
          <p className="mt-1 text-sm text-muted">
            A factor multiplies both a category&rsquo;s average fortnight and its spread, so a busy
            month is proportionally more variable rather than merely larger. 1.30× is 30% above an
            average fortnight and 0.70× is 30% below; the twelve average to 1.0, which leaves the
            annual average untouched. They describe the history observed, not a promise about any
            particular month.
          </p>
          <ul className="mt-2">
            {shaped.map((bucket) => (
              <SeasonalCategory key={bucket.category} bucket={bucket} currentMonth={currentMonth} />
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted">
          No category in this twin carries a seasonal profile, so every month is treated as an
          average one.
        </p>
      )}

      {shaped.length > 0 && flat.length > 0 ? (
        <p className="mt-3 text-xs text-faint">
          No seasonal pattern was recorded for {flat.map((b) => label(b.category)).join(", ")}:
          treated as flat across the year.
        </p>
      ) : null}
    </Card>
  );
}
