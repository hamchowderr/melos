import { defineConfig } from '@playwright/test';
import { STATE } from './tests/preview/global-setup';

/**
 * Manual specs against a deployed preview (AST-E2E-002), never run in CI. PLAYWRIGHT_BASE_URL is
 * the preview URL; VERCEL_AUTOMATION_BYPASS_SECRET passes Vercel deployment protection when set,
 * through the cookie global setup stores, never as a header on every request.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL) throw new Error('Set PLAYWRIGHT_BASE_URL to the preview deploy URL.');

export default defineConfig({
  testDir: './tests/preview',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  globalSetup: './tests/preview/global-setup.ts',
  use: { baseURL, trace: 'off', storageState: STATE },
});
