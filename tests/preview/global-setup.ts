import { request } from '@playwright/test';

/**
 * Trades VERCEL_AUTOMATION_BYPASS_SECRET for Vercel's bypass cookie, scoped to the preview host, so
 * no request carries the secret as a header: the browser's PUT to R2 would send it to Cloudflare,
 * and its preflight would fail, since the bucket allows only Content-Type (§7.5).
 */
export const STATE = 'tests/preview/.auth/bypass.json';

export default async function globalSetup(): Promise<void> {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const context = await request.newContext({ baseURL });
  if (bypass) {
    const response = await context.get('/', {
      headers: { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' },
      maxRedirects: 0,
    });
    if (response.status() >= 400) throw new Error(`Bypass refused: ${response.status()}`);
  }
  await context.storageState({ path: STATE });
  await context.dispose();
}
