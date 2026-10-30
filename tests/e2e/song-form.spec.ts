import { expect, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, activeOrganizationId, setMemberRole, signUpWithWorkspace } from './support';

const dialog = (page: Page) => page.getByRole('dialog').or(page.getByRole('alertdialog'));
const songRow = (page: Page, title: string) =>
  page.getByRole('row').filter({ has: page.getByRole('link', { name: title, exact: true }) });

/** Opens a dialog from its button; a click before hydration retries. */
const open = (page: Page, name: string) =>
  expect(async () => {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(dialog(page)).toBeVisible({ timeout: 1_000 });
  }).toPass(AUTH_REDIRECT);

test('melos-rpr.33: an owner creates, edits and deletes a song (CAT-E2E-001)', async ({ page }) => {
  await signUpWithWorkspace(page, 'Songs');
  await page.goto('/catalog');
  await open(page, 'New song');
  await dialog(page).getByLabel('Title', { exact: true }).fill('Test Song');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Test Song', AUTH_REDIRECT);
  // D-10: the song's first recording has the same title.
  await expect(page.getByRole('region', { name: /^Test Song/ })).toHaveCount(1);
  await page.goto('/catalog');
  await expect(songRow(page, 'Test Song').getByRole('cell').last()).toHaveText('1');

  await songRow(page, 'Test Song').getByRole('link').click();
  await open(page, 'Edit');
  await dialog(page).getByLabel('Title', { exact: true }).fill('Test Song II');
  await dialog(page).getByLabel('Alternate titles').fill('TS2');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Test Song II');
  await page.goto('/catalog');
  await expect(songRow(page, 'Test Song II')).toContainText('Also known as TS2');

  // An invalid ISWC is refused and nothing is saved.
  await songRow(page, 'Test Song II').getByRole('link').click();
  await open(page, 'Edit');
  await dialog(page).getByLabel('ISWC').fill('T-123');
  await dialog(page).getByLabel('Description').fill('Not saved');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page).getByText('The ISWC is not valid.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Not saved')).toHaveCount(0);

  await open(page, 'Delete');
  await dialog(page).getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/catalog$/, AUTH_REDIRECT);
  await expect(page.getByRole('link', { name: 'Test Song II' })).toHaveCount(0);
});

test('melos-rpr.33: a member edits but sees no Delete', async ({ page }) => {
  await signUpWithWorkspace(page, 'Member');
  await page.goto('/catalog');
  await open(page, 'New song');
  await dialog(page).getByLabel('Title', { exact: true }).fill('Kept Song');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kept Song', AUTH_REDIRECT);
  await setMemberRole(await activeOrganizationId(page), 'member');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
});
