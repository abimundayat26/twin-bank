/**
 * A spending category's seasonal shape as twelve tiny monthly bars, with a faint
 * line at an average month (1.0×). The twin's current month is drawn in ink so the
 * reader can see where in the year they are. Hover a bar for its month and factor.
 */

import { monthFactors } from "@/lib/seasonal";
import type { SeasonalProfile } from "@/lib/types";

const BAR = 3;
const GAP = 2;
const HEIGHT = 20;
const WIDTH = 12 * BAR + 11 * GAP;

export function SeasonalSparkline({
  profile,
  currentMonth,
  label,
}: {
  profile: SeasonalProfile;
  /** 1-12: the month the twin describes. */
  currentMonth: number;
  /** Accessible description, e.g. the busiest/quietest summary. */
  label: string;
}) {
  const months = monthFactors(profile);
  const max = Math.max(1, ...months.map((m) => m.factor));
  const y = (factor: number) => HEIGHT - (factor / max) * HEIGHT;

  return (
    <svg
      role="img"
      aria-label={label}
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="shrink-0 overflow-visible"
    >
      <line
        x1={0}
        x2={WIDTH}
        y1={y(1)}
        y2={y(1)}
        className="stroke-line"
        strokeWidth={1}
        strokeDasharray="2 2"
      />
      {months.map(({ month, name, factor }, i) => {
        const x = i * (BAR + GAP);
        const top = Math.min(y(factor), HEIGHT - 1);
        return (
          <g key={month}>
            <title>{`${name}: ${factor.toFixed(2)}× an average fortnight`}</title>
            {/* Hit target wider and taller than the bar. */}
            <rect x={x - GAP / 2} y={0} width={BAR + GAP} height={HEIGHT} fill="transparent" />
            <rect
              x={x}
              y={top}
              width={BAR}
              height={HEIGHT - top}
              rx={1}
              className={month === currentMonth ? "fill-ink" : "fill-muted"}
            />
          </g>
        );
      })}
    </svg>
  );
}
