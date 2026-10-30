import { expect, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, insertWorkspaceRows, signUpWithWorkspace } from './support';

const dialog = (page: Page) => page.getByRole('dialog');
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

async function save(page: Page) {
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toHaveCount(0);
}

test('melos-rpr.35: aliases, identifiers tied to them, and a duplicate IPI (CAT-008)', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Aliases');
  const at = new Date().toISOString();
  const person = (id: string, display_name: string) => ({
    ...{ id, party_kind: 'person', display_name, created_at: at, updated_at: at },
  });
  await insertWorkspaceRows(page, {
    parties: [person('pty_JORDAN', 'Jordan Tate'), person('pty_SAM', 'Sam Park')],
    party_identifiers: [
      {
        ...{ id: 'pid_SAM', party_id: 'pty_SAM', identifier_type: 'IPI' },
        ...{ identifier_value: '00099999999', created_at: at },
      },
    ],
  });
  await page.goto('/people/pty_JORDAN');

  await open(page, 'Aliases');
  await dialog(page).getByRole('button', { name: 'Add alias' }).click();
  await dialog(page).getByLabel('Alias 1 name').fill('JT');
  await save(page);
  await expect(detail(page, 'Aliases')).toHaveText('JT');

  await open(page, 'Identifiers');
  await dialog(page).getByRole('button', { name: 'Add identifier' }).click();
  await dialog(page).getByLabel('Identifier 1 value').fill('00012345678');
  await dialog(page).getByLabel('Identifier 1 alias').selectOption({ label: 'JT' });
  await save(page);
  await expect(detail(page, 'Identifiers')).toHaveText('IPI 00012345678 for JT');

  // §4.4: deleting the alias keeps the identifier, no longer tied to it.
  await open(page, 'Aliases');
  await dialog(page).getByRole('button', { name: 'Remove alias 1' }).click();
  await save(page);
  await expect(detail(page, 'Identifiers')).toHaveText('IPI 00012345678');

  await open(page, 'Identifiers');
  await dialog(page).getByRole('button', { name: 'Add identifier' }).click();
  await dialog(page).getByLabel('Identifier 2 value').fill('00099999999');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(
    dialog(page).getByText('Another party already holds this identifier.'),
  ).toBeVisible();
  await page.reload();
  await expect(detail(page, 'Identifiers')).toHaveText('IPI 00012345678');
});
