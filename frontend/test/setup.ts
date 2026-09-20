/**
 * Matchers, polyfills and teardown for the component tests.
 *
 * `cleanup` unmounts between tests so one test's DOM cannot be found by the next.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * jsdom has no ResizeObserver, and React Flow constructs one on mount.
 *
 * A stub that observes nothing is the honest shape here: jsdom reports every
 * element as 0x0, so a real implementation would only ever report zeroes. It lets
 * a component *containing* a canvas render, which is what the tests need; the
 * drawn graph itself is still covered by the pure tests in `lib/graph.test.ts`.
 */
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(() => {
  cleanup();
});
