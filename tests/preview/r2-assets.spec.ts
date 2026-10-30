import { expect, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, signIn } from '../e2e/support';

// Run by hand against a preview deploy on R2 (melos-rpr.41, U-27):
//   PLAYWRIGHT_BASE_URL=https://… NORTHSTAR_WORKSPACE_ID=… MELOS_DEMO_PASSWORD=… \
//   npx playwright test -c playwright.preview.config.ts
// It uploads tests/e2e/fixtures/tone.wav to Home Again in the seeded Northstar workspace. Only the
// R2 host and the key are logged, never a query string, which carries the signature.

const workspaceId = process.env.NORTHSTAR_WORKSPACE_ID ?? '';
const password = process.env.MELOS_DEMO_PASSWORD ?? '';
const R2 = /\.r2\.cloudflarestorage\.com\//;
const player = (page: Page) => page.getByLabel('Audio for Home Again', { exact: true });
const playable = (page: Page) =>
  expect.poll(() => player(page).evaluate((a: HTMLAudioElement) => a.readyState), AUTH_REDIRECT);

test('melos-rpr.41: a browser PUT reaches R2 and the audio plays and re-signs (AST-E2E-002)', async ({
  page,
}) => {
  expect(workspaceId, 'NORTHSTAR_WORKSPACE_ID').not.toBe('');
  expect(password, 'MELOS_DEMO_PASSWORD').not.toBe('');
  await page.goto('/sign-in');
  await signIn(page, { email: 'jordan@silverline.example', password }, /\/$/);
  await page.goto('/catalog');
  await page.getByRole('link', { name: 'Home Again' }).click();

  const putResponse = page.waitForResponse(
    (r) => R2.test(r.url()) && r.request().method() === 'PUT',
  );
  await page.getByLabel('Upload audio for Home Again').setInputFiles('tests/e2e/fixtures/tone.wav');
  const put = await putResponse;
  const url = new URL(put.url());
  // Virtual-hosted style: the bucket is in the host, the key is the whole path.
  const key = decodeURIComponent(url.pathname.slice(1));
  console.log(`PUT ${url.host} ${key} -> ${put.status()}`);
  expect(put.ok()).toBe(true);
  expect(key.startsWith(`${workspaceId}/`)).toBe(true);

  await expect(player(page)).toBeVisible(AUTH_REDIRECT);
  await playable(page);

  // The first audio GET fails as an expired URL does; the player re-signs once and plays.
  let refused = false;
  await page.route(R2, (route) => {
    if (refused || route.request().method() !== 'GET') return route.continue();
    refused = true;
    return route.fulfill({ status: 403, body: 'expired' });
  });
  await page.reload();
  await playable(page);
  expect(refused).toBe(true);
  await expect(page.getByText('The audio could not be loaded.')).toHaveCount(0);
});
