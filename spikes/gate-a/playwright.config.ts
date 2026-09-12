import { defineConfig } from "@playwright/test";

const PORT = 3100;
const AIMOCK_PORT = 4010;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // GET / on AIMock is a 404 even when healthy, so wait on the port, not a URL.
      command: "npx aimock -c aimock.json",
      port: AIMOCK_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `node scripts/migrate.mjs && npx next start -p ${PORT}`,
      port: PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        AIMOCK_URL: `http://127.0.0.1:${AIMOCK_PORT}`,
        COPILOTKIT_TELEMETRY_DISABLED: "true",
        NEXT_TELEMETRY_DISABLED: "1",
        AUTH_DATABASE_URL: "file:./data/e2e-auth.db",
        MASTRA_DATABASE_URL: "file:./data/e2e-mastra.db",
        BETTER_AUTH_URL: `http://localhost:${PORT}`,
      },
    },
  ],
});
