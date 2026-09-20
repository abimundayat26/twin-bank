/**
 * The Impact Score, as a badge (SM-5).
 *
 * The level and its reasons are computed in the backend (7.3, P2, G-6); this
 * renders them. The reasons travel in the tooltip and the accessible name, so
 * the badge is never an unexplained number, and the level is carried by a word
 * and a shape as well as a colour (G-18).
 *
 * A result with no `impact` shows no badge. Guessing a level from the rows
 * would be the frontend computing finance (E-5).
 */

import type { ImpactAssessment } from "@/lib/types";

const LEVELS = {
  low: { label: "Low impact", icon: "●", tone: "border-good/70 text-good" },
  moderate: { label: "Moderate impact", icon: "◆", tone: "border-caution/70 text-caution" },
  high: { label: "High impact", icon: "▲", tone: "border-bad/70 bg-bad/10 text-bad" },
} as const;

export function ImpactBadge({ impact }: { impact: ImpactAssessment }) {
  const level = LEVELS[impact.level];
  // Read out as "High impact: chance of low balance rises by 99 points, …".
  const description = impact.reasons.length
    ? `${level.label}: ${impact.reasons.join(", ")}`
    : level.label;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${level.tone}`}
      title={description}
      aria-label={description}
    >
      <span aria-hidden="true">{level.icon}</span>
      {level.label}
    </span>
  );
}
