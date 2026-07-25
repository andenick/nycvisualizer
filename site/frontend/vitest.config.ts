import { defineConfig } from "vitest/config";

// Light setup: the flow engine is deliberately host-agnostic and its math is pure, so the
// tests run in the default node environment (no jsdom). The engine integration test stubs
// the handful of globals it touches (performance/rAF/document/window) itself.
export default defineConfig({
  test: {
    // W2 (2026-07-24) widened from `src/flow/__tests__/**` — the borough grouping is now
    // the DEFAULT bus encoding and had no tests at all, so lib/ needs to be in scope.
    // Keep this to PURE modules: the config runs in the node environment (no jsdom), so
    // anything touching the DOM belongs in the browser harness, not here.
    include: ["src/flow/__tests__/**/*.test.ts", "src/lib/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
