import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Offline, keyless defaults. Integration tests override the database files and point
    // MELOS_LLM_BASE_URL at an in-process AIMock before importing app modules.
    env: {
      COPILOTKIT_TELEMETRY_DISABLED: 'true',
      BETTER_AUTH_SECRET: 'vitest-only-placeholder-not-a-real-secret',
      BETTER_AUTH_URL: 'http://localhost:3100',
      MELOS_LLM_BASE_URL: 'http://127.0.0.1:4010/v1',
      MELOS_CONTROL_DATABASE_URL: 'file:./data/test-control.db',
      MELOS_AGENT_DATABASE_URL: 'file:./data/test-agent.db',
      MELOS_AUTH_MAILER: 'memory',
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration tests use local libSQL files; run files one at a time.
    fileParallelism: false,
  },
});
