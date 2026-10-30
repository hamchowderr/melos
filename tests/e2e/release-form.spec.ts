import { expect, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, insertWorkspaceRows, signUpWithWorkspace } from './support';

const dialog = (page: Page) => page.getByRole('dialog');
const releases = (page: Page) => page.getByRole('region', { name: 'Releases' });

/** Opens a dialog from its button; a click before hydration retries. */
const open = (page: Page, button: ReturnType<Page['getByRole']>) =>
  expect(async () => {
    await button.click();
    await expect(dialog(page)).toBeVisible({ timeout: 1_000 });
  }).toPass(AUTH_REDIRECT);

test('melos-rpr.38: an owner adds a single with its track (CAT-007, D-1)', async ({ page }) => {
  await signUpWithWorkspace(page, 'Pressing');
  const at = new Date().toISOString();
  const stamps = { created_at: at, updated_at: at };
  await insertWorkspaceRows(page, {
    compositions: [{ id: 'cmp_GLOW', title: 'Glow Line', ...stamps }],
    recordings: [{ id: 'rec_GLOW', composition_id: 'cmp_GLOW', title: 'Glow Line', ...stamps }],
  });
  await page.goto('/catalog/compositions/cmp_GLOW');
  await expect(releases(page).getByText('This song is not on a release yet.')).toBeVisible();

  // A bad check digit is refused (D-1) and the dialog stays open.
  await open(page, page.getByRole('button', { name: 'Add release' }));
  await dialog(page).getByLabel('Title', { exact: true }).fill('Glow Line');
  await dialog(page).getByLabel('UPC/EAN').fill('012345678901');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page).getByText('The UPC/EAN is not valid. Check its digits.')).toBeVisible();

  await dialog(page).getByLabel('UPC/EAN').fill('012345678905');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toHaveCount(0);
  const release = releases(page).locator('div', {
    has: page.getByRole('heading', { name: 'Glow Line' }),
  });
  await expect(
    release.locator('dt', { hasText: /^Track$/ }).locator('xpath=following-sibling::dd[1]'),
  ).toHaveText('1');
  await expect(release.getByText('012345678905')).toBeVisible();

  await page.goto('/catalog?q=Glow+Line');
  await expect(releases(page).getByText('Glow Line')).toBeVisible();
});
