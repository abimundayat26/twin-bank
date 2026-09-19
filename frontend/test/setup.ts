/**
 * Matchers and teardown for the component tests.
 *
 * `cleanup` unmounts between tests so one test's DOM cannot be found by the next.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
