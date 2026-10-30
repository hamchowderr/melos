import { defineConfig } from '@playwright/test';

/**
 * Manual specs against a deployed preview (AST-E2E-002), never run in CI. PLAYWRIGHT_BASE_URL is
 * the preview URL; VERCEL_AUTOMATION_BYPASS_SECRET passes Vercel deployment protection when set.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL) throw new Error('Set PLAYWRIGHT_BASE_URL to the preview deploy URL.');
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  testDir: './tests/preview',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'off',
    extraHTTPHeaders: bypass ? { 'x-vercel-protection-bypass': bypass } : {},
  },
});
