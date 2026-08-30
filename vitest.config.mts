import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["vitest.global-setup.ts"],
    setupFiles: ["vitest.env-setup.ts"],
    fileParallelism: false,
  },
});
