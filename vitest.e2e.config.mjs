import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 180_000
  }
});
