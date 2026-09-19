import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * One jsdom environment for everything.
 *
 * The `lib/` tests are pure and would run marginally faster under node, but a
 * single environment keeps the config honest and the difference is milliseconds.
 * The alias mirrors the `@/*` path in tsconfig.json, which Vite does not read.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
