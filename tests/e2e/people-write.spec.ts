import { expect, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, activeOrganizationId, setMemberRole, signUpWithWorkspace } from './support';

const dialog = (page: Page) => page.getByRole('dialog').or(page.getByRole('alertdialog'));
const detail = (page: Page, term: string) =>
  page
    .locator('dt', { hasText: new RegExp(`^${term}$`) })
    .locator('xpath=following-sibling::dd[1]');

/** Opens a dialog from its button; a click before hydration retries. */
const open = (page: Page, name: string) =>
  expect(async () => {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(dialog(page)).toBeVisible({ timeout: 1_000 });
  }).toPass(AUTH_REDIRECT);

async function create(page: Page, button: string, name: string, email?: string) {
  await page.goto('/people');
  await open(page, button);
  await dialog(page).getByLabel('Name').fill(name);
  if (email) await dialog(page).getByLabel('Email').fill(email);
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name, AUTH_REDIRECT);
  return page.url().split('/').pop() as string;
}

test('melos-rpr.30: an owner creates, renames and reaches people and organizations', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'People');
  const riley = await create(page, 'New person', 'Riley Stone', 'riley@example.test');
  await expect(detail(page, 'Email')).toHaveText('riley@example.test');

  await open(page, 'Edit');
  await dialog(page).getByLabel('Name').fill('Riley Stone-Hart');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Riley Stone-Hart');

  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Riley Stone-Hart');

  await create(page, 'New organization', 'Harbor Lane Music');
  await expect(detail(page, 'Kind')).toHaveText('Organization');

  // §6.15: the same name, any case, is a possible duplicate, which never blocks the save.
  await page.goto('/people');
  await open(page, 'New person');
  await dialog(page).getByLabel('Name').fill('riley stone-hart');
  await dialog(page).getByLabel('Email').focus();
  await expect(dialog(page).getByText('Possible duplicate:')).toBeVisible();
  await expect(dialog(page).getByRole('link', { name: 'Riley Stone-Hart' })).toHaveAttribute(
    'href',
    `/people/${riley}`,
  );
});

test('melos-rpr.30: create and edit controls follow the roles', async ({ page }) => {
  await signUpWithWorkspace(page, 'Viewer');
  await create(page, 'New person', 'Sam Park');
  await setMemberRole(await activeOrganizationId(page), 'viewer');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await page.goto('/people');
  await expect(page.getByRole('table')).toContainText('Sam Park');
  await expect(page.getByRole('button', { name: 'New person' })).toHaveCount(0);
});
