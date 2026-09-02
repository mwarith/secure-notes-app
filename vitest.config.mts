import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Native tsconfig-paths resolution (Vite 4+); replaces the redundant
    // vite-tsconfig-paths plugin per its own deprecation notice.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["vitest.global-setup.ts"],
    setupFiles: ["vitest.env-setup.ts"],
    fileParallelism: false,
  },
});
