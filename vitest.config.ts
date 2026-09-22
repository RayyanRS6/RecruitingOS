import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/api/src/**/*.test.ts",
      "apps/shell/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    reporters: ["default"],
  },
});
