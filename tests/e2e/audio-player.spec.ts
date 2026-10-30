import { expect, type Page, test } from '@playwright/test';
import {
  AUTH_REDIRECT,
  activeOrganizationId,
  insertWorkspaceRows,
  setMemberRole,
  signUpWithWorkspace,
} from './support';

const SONG = '/catalog/compositions/cmp_HUM';
const player = (page: Page) => page.getByLabel('Audio for Hum Line', { exact: true });

/** Waits until the player has loaded and stands at the preview start, 1.5 s. */
const startsAtPreview = (page: Page) =>
  expect
    .poll(() => player(page).evaluate((a: HTMLAudioElement) => (a.readyState ? a.currentTime : -1)))
    .toBeCloseTo(1.5, 1);

test('melos-rpr.40: uploaded audio plays from the preview start and re-signs once (CAT-E2E-005)', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Audio');
  const at = new Date().toISOString();
  const stamps = { created_at: at, updated_at: at };
  await insertWorkspaceRows(page, {
    compositions: [{ id: 'cmp_HUM', title: 'Hum Line', ...stamps }],
    recordings: [
      {
        ...{ id: 'rec_HUM', composition_id: 'cmp_HUM', title: 'Hum Line' },
        ...{ preview_start_ms: 1500, ...stamps },
      },
    ],
  });
  await page.goto(SONG);

  const upload = page.getByLabel('Upload audio for Hum Line');
  await expect(async () => {
    await upload.setInputFiles('tests/e2e/fixtures/tone.wav');
    await expect(player(page)).toBeVisible({ timeout: 2_000 });
  }).toPass(AUTH_REDIRECT);
  await startsAtPreview(page);

  // Every audio request fails as an expired URL does: the player re-signs exactly once.
  const requests: string[] = [];
  await page.route('**/api/assets/local/**', async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 403, body: 'expired' });
  });
  await page.reload();
  await expect(page.getByText('The audio could not be loaded.')).toBeVisible();
  expect(requests).toHaveLength(2);
  await page.unroute('**/api/assets/local/**');

  // When only the first request fails, the re-signed URL plays from the preview start.
  let refused = false;
  await page.route('**/api/assets/local/**', (route) => {
    if (refused) return route.continue();
    refused = true;
    return route.fulfill({ status: 403, body: 'expired' });
  });
  await page.reload();
  await startsAtPreview(page);
  await expect(page.getByText('The audio could not be loaded.')).toHaveCount(0);
  await page.unroute('**/api/assets/local/**');

  await setMemberRole(await activeOrganizationId(page), 'viewer');
  await page.reload();
  await startsAtPreview(page);
  await expect(page.getByLabel('Upload audio for Hum Line')).toHaveCount(0);
});
