import { expect, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, insertWorkspaceRows, signUpWithWorkspace } from './support';

const dialog = (page: Page) => page.getByRole('dialog');
const take = (page: Page) => page.getByRole('region', { name: 'Tide Song', exact: true });

/** Opens a dialog from its button; a click before hydration retries. */
const open = (page: Page, name: string) =>
  expect(async () => {
    await take(page).getByRole('button', { name }).click();
    await expect(dialog(page)).toBeVisible({ timeout: 1_000 });
  }).toPass(AUTH_REDIRECT);

test('melos-rpr.35: a primary link with a 0:30 start shows on the song page (CAT-E2E-005)', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Links');
  const at = new Date().toISOString();
  const stamps = { created_at: at, updated_at: at };
  await insertWorkspaceRows(page, {
    compositions: [{ id: 'cmp_TIDE', title: 'Tide Song', ...stamps }],
    recordings: [{ id: 'rec_TIDE', composition_id: 'cmp_TIDE', title: 'Tide Song', ...stamps }],
  });
  await page.goto('/catalog/compositions/cmp_TIDE');

  await open(page, 'Edit recording');
  await dialog(page).getByLabel('Preview start').fill('0:30');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toHaveCount(0);

  await open(page, 'Edit links');
  await dialog(page).getByRole('button', { name: 'Add link' }).click();
  await dialog(page).getByLabel('Link 1 URL').fill('https://player.example.test/tide');
  await dialog(page).getByRole('button', { name: 'Add link' }).click();
  await dialog(page).getByLabel('Link 2 URL').fill('https://files.example.test/tide.wav');
  await dialog(page).getByLabel('Link 2 type').selectOption('cloud_file');
  await dialog(page).getByLabel('Link 2 label').fill('Stems');
  await dialog(page).getByRole('radio').first().check();
  await dialog(page).getByRole('button', { name: 'Save' }).click();

  const player = take(page).getByRole('link', { name: 'Open player · starts 0:30' });
  await expect(player).toHaveAttribute('href', 'https://player.example.test/tide');
  await expect(take(page).getByRole('link', { name: 'Stems' })).toBeVisible();
  await page.reload();
  await expect(player).toBeVisible();
});
