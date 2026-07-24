import { defineConfig } from "vitest/config";

// Light setup: the flow engine is deliberately host-agnostic and its math is pure, so the
// tests run in the default node environment (no jsdom). The engine integration test stubs
// the handful of globals it touches (performance/rAF/document/window) itself.
export default defineConfig({
  test: {
    include: ["src/flow/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
