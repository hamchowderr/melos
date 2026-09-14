import { defineConfig } from '@playwright/test';
import { DEMO_JORDAN } from './tests/e2e/demo-seed';

const PORT = 3100;
const AIMOCK_PORT = 4010;
const baseURL = `http://localhost:${PORT}`;

// In CI the AIMock container is started by the workflow; locally Playwright starts the npm CLI.
const aimockServer = process.env.CI
  ? []
  : [
      {
        // GET / on AIMock is a 404 even when healthy, so wait on the port, not a URL.
        command: 'npx aimock -c aimock.json',
        port: AIMOCK_PORT,
        reuseExistingServer: false,
        timeout: 60_000,
      },
    ];

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: [
    ...aimockServer,
    {
      // Builds with the same keyless env it runs with. Never run this while `next dev` is up.
      // Read specs use the seeded Northstar catalog (D-9); --replace deletes the seed a previous
      // run left, so every run starts from the fixture.
      command: `npm run db:migrate && npx tsx scripts/seed-demo.ts --replace && npm run build && npx next start -p ${PORT}`,
      port: PORT,
      reuseExistingServer: false,
      timeout: 600_000,
      env: {
        COPILOTKIT_TELEMETRY_DISABLED: 'true',
        NEXT_TELEMETRY_DISABLED: '1',
        BETTER_AUTH_SECRET: 'playwright-only-placeholder-not-a-real-secret',
        BETTER_AUTH_URL: baseURL,
        MELOS_CONTROL_DATABASE_URL: 'file:./data/e2e-control.db',
        MELOS_AGENT_DATABASE_URL: 'file:./data/e2e-agent.db',
        // Every workspace created in the suite provisions a database file here, not in .data.
        MELOS_WORKSPACE_DATA_DIR: 'data/e2e-workspaces',
        MELOS_LLM_BASE_URL: `http://127.0.0.1:${AIMOCK_PORT}/v1`,
        MELOS_DEMO_PASSWORD: DEMO_JORDAN.password,
      },
    },
  ],
});
