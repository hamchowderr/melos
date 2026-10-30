import { expect, type Page, test } from '@playwright/test';
import {
  AUTH_REDIRECT,
  activeOrganizationId,
  insertWorkspaceRows,
  setMemberRole,
  signUpWithWorkspace,
} from './support';

const SONG = '/catalog/compositions/cmp_TIDE';
const share = (page: Page, n: number) => page.getByLabel(`Writer ${n} share`);
const total = (page: Page) => page.getByTestId('split-total');

/** Setup rows (D-9): two people and a song with no writers yet. */
async function addSong(page: Page) {
  const at = new Date().toISOString();
  const person = (id: string, display_name: string) => ({
    ...{ id, party_kind: 'person', display_name, created_at: at, updated_at: at },
  });
  await insertWorkspaceRows(page, {
    parties: [person('pty_RILEY', 'Riley Stone'), person('pty_SAM', 'Sam Park')],
    compositions: [{ id: 'cmp_TIDE', title: 'Tide Song', created_at: at, updated_at: at }],
  });
}

/** Opens the editor; a click before hydration retries. */
const edit = (page: Page) =>
  expect(async () => {
    await page.getByRole('button', { name: 'Edit writers' }).click();
    await expect(page.getByRole('form', { name: 'Edit writers' })).toBeVisible({ timeout: 1_000 });
  }).toPass(AUTH_REDIRECT);

/** Adds a writer row with `name` and `percent`. */
async function addWriter(page: Page, n: number, name: string, percent: string) {
  await page.getByRole('button', { name: 'Add writer' }).click();
  await page.getByLabel(`Writer ${n} person`).click();
  await page.getByRole('option', { name }).click();
  await share(page, n).fill(percent);
}

test('melos-rpr.29: an owner saves a 60/40 writer split, and over 100% is refused', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Splits');
  await addSong(page);
  await page.goto(SONG);
  await edit(page);
  await addWriter(page, 1, 'Riley Stone', '60');
  await addWriter(page, 2, 'Sam Park', '40');
  await expect(total(page)).toHaveText('Total 100.00%, 0.00% remaining');
  await page.getByRole('button', { name: 'Save' }).click();

  const writers = page.getByRole('table', { name: 'Writers' });
  await expect(writers.getByTestId('share-total')).toHaveText('100.00%');
  await page.reload();
  await expect(writers.getByRole('row', { name: /Riley Stone.*60\.00%/ })).toBeVisible();
  await expect(writers.getByRole('row', { name: /Sam Park.*40\.00%/ })).toBeVisible();

  // D-3: a total above 100% is refused, and nothing moves to make it fit (P-29).
  await edit(page);
  await share(page, 2).fill('50');
  await expect(total(page)).toHaveText('Total 110.00%, 0.00% remaining');
  await expect(page.getByText('The total is over 100%.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(share(page, 1)).toHaveValue('60.00');
});

test('melos-rpr.29: a stale second tab gets a reload notice, and a viewer has no Edit', async ({
  page,
  context,
}) => {
  await signUpWithWorkspace(page, 'Stale');
  await addSong(page);
  await page.goto(SONG);
  await edit(page);
  await addWriter(page, 1, 'Riley Stone', '100');

  const other = await context.newPage();
  await other.goto(SONG);
  await edit(other);
  await addWriter(other, 1, 'Sam Park', '100');
  await other.getByRole('button', { name: 'Save' }).click();
  await expect(other.getByRole('table', { name: 'Writers' })).toContainText('Sam Park');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Someone changed these splits')).toBeVisible();
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('table', { name: 'Writers' })).toContainText('Sam Park');

  await setMemberRole(await activeOrganizationId(page), 'viewer');
  await page.reload();
  await expect(page.getByRole('table', { name: 'Writers' })).toContainText('Sam Park');
  await expect(page.getByRole('button', { name: 'Edit writers' })).toHaveCount(0);
});
