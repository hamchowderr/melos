import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // The CopilotKit runtime sends telemetry by default; tests stay offline.
    env: { COPILOTKIT_TELEMETRY_DISABLED: "true" },
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Tests share local libSQL files; run them one at a time.
    fileParallelism: false,
  },
});
