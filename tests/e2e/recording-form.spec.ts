import { expect, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, insertWorkspaceRows, signUpWithWorkspace } from './support';

const dialog = (page: Page) => page.getByRole('dialog');
const take = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });
const detail = (page: Page, region: string, term: string) =>
  take(page, region)
    .locator('dt', { hasText: new RegExp(`^${term}$`) })
    .locator('xpath=following-sibling::dd[1]');

/** Opens a dialog from its button; a click before hydration retries. */
const open = (page: Page, button: ReturnType<Page['getByRole']>) =>
  expect(async () => {
    await button.click();
    await expect(dialog(page)).toBeVisible({ timeout: 1_000 });
  }).toPass(AUTH_REDIRECT);

async function save(page: Page) {
  await dialog(page).getByRole('button', { name: 'Save' }).click();
}

test('melos-rpr.35: an owner adds and edits recordings (CAT-E2E-002, CAT-E2E-004)', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Takes');
  const at = new Date().toISOString();
  const stamps = { created_at: at, updated_at: at };
  await insertWorkspaceRows(page, {
    compositions: [{ id: 'cmp_TIDE', title: 'Tide Song', ...stamps }],
    recordings: [{ id: 'rec_TIDE', composition_id: 'cmp_TIDE', title: 'Tide Song', ...stamps }],
  });
  await page.goto('/catalog/compositions/cmp_TIDE');

  await open(page, page.getByRole('button', { name: 'Add recording' }));
  await expect(dialog(page).getByLabel('Title')).toHaveValue('Tide Song');
  await dialog(page).getByLabel('Version').fill('Instrumental');
  await save(page);
  await expect(take(page, 'Tide Song (Instrumental)')).toBeVisible();
  await expect(page.getByRole('region', { name: /^Tide Song/ })).toHaveCount(2);

  await open(page, take(page, 'Tide Song').getByRole('button', { name: 'Edit recording' }));
  await dialog(page).getByLabel('ISRC').fill('USDMO2600009');
  await dialog(page).getByLabel('BPM').fill('92');
  await dialog(page).getByLabel('Key').fill('A minor');
  await save(page);
  await expect(detail(page, 'Tide Song', 'ISRC')).toHaveText('US-DMO-26-00009');
  await expect(detail(page, 'Tide Song', 'BPM')).toHaveText('92');
  await expect(detail(page, 'Tide Song', 'Key')).toHaveText('A minor');

  // The ISRC is unique among live recordings: the other take cannot take it.
  const instrumental = take(page, 'Tide Song (Instrumental)');
  await open(page, instrumental.getByRole('button', { name: 'Edit recording' }));
  await dialog(page).getByLabel('ISRC').fill('US-DMO-26-00009');
  await save(page);
  await expect(dialog(page).getByText('Another recording already holds this ISRC.')).toBeVisible();
  await page.reload();
  await expect(detail(page, 'Tide Song (Instrumental)', 'ISRC')).toHaveCount(0);
});
