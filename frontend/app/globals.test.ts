/**
 * A guard on the stylesheet, not on rendered behaviour.
 *
 * The component tests run in jsdom with no CSS pipeline, so nothing there can
 * observe a media query taking effect. What this can do is stop the reduced
 * motion rule being dropped by a later edit without anyone noticing: SPEC
 * section 11 requires it, and its absence is invisible to every other test in
 * the suite.
 *
 * Whether a real browser honours the rule is a presenter-side check, noted as
 * such rather than implied by this file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "globals.css"), "utf8");

function reducedMotionBlock(): string {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(start, "globals.css has no prefers-reduced-motion block").toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", css.indexOf("{", start) + 1) + 2);
}

describe("globals.css", () => {
  it("neutralises animation and transition timing under reduced motion", () => {
    const block = reducedMotionBlock();

    expect(block).toContain("animation-duration: 0.01ms !important");
    expect(block).toContain("transition-duration: 0.01ms !important");
  });

  it("stops looping animations rather than only shortening them", () => {
    // React Flow marches dashes along the purchase edge forever (`animated`
    // in lib/graph.ts). A shorter loop is still a loop, so the pass count has
    // to be capped as well.
    expect(reducedMotionBlock()).toContain("animation-iteration-count: 1 !important");
  });

  it("applies to pseudo-elements, where decorative animation tends to hide", () => {
    const block = reducedMotionBlock();

    expect(block).toContain("*::before");
    expect(block).toContain("*::after");
  });
});
