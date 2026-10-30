import { expect, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, insertWorkspaceRows, signUpWithWorkspace } from './support';

const SONG = '/catalog/compositions/cmp_TIDE';
const totalOf = (page: Page, table: string) =>
  page.getByRole('table', { name: table }).getByTestId('share-total');

/** Setup rows (D-9): a person, an organization and a song with one recording and no shares. */
async function addSong(page: Page) {
  const at = new Date().toISOString();
  const party = (id: string, party_kind: string, display_name: string) => ({
    ...{ id, party_kind, display_name, created_at: at, updated_at: at },
  });
  await insertWorkspaceRows(page, {
    parties: [
      party('pty_RILEY', 'person', 'Riley Stone'),
      party('pty_HARBOR', 'organization', 'Harbor Lane Music'),
    ],
    compositions: [{ id: 'cmp_TIDE', title: 'Tide Song', created_at: at, updated_at: at }],
    recordings: [
      {
        id: 'rec_TIDE',
        composition_id: 'cmp_TIDE',
        title: 'Tide Song',
        created_at: at,
        updated_at: at,
      },
    ],
  });
}

/** Opens an editor from its button; a click before hydration retries. */
const edit = (page: Page, name: string) =>
  expect(async () => {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('form', { name })).toBeVisible({ timeout: 1_000 });
  }).toPass(AUTH_REDIRECT);

async function addHolder(page: Page, n: number, name: string, percent: string) {
  await page.getByRole('button', { name: 'Add holder' }).click();
  await page.getByLabel(`Holder ${n} party`).click();
  await page.getByRole('option', { name }).click();
  await page.getByLabel(`Holder ${n} share`).fill(percent);
}

test('melos-rpr.31: publishing and master splits save, and territories never mix (RGT-E2E-002, RGT-E2E-003)', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Holders');
  await addSong(page);
  await page.goto(SONG);

  await edit(page, 'Add publishing set');
  await expect(page.getByLabel('Publishing territory')).toHaveValue('WORLD');
  await addHolder(page, 1, 'Riley Stone', '50');
  await addHolder(page, 2, 'Harbor Lane Music', '50');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(totalOf(page, 'Publishing WORLD')).toHaveText('100.00%');
  await page.reload();
  await expect(totalOf(page, 'Publishing WORLD')).toHaveText('100.00%');

  // P-05: a country set beside WORLD is refused.
  await page.getByRole('tab', { name: 'New territory' }).click();
  await edit(page, 'Add publishing set');
  await page.getByLabel('Publishing territory').fill('US');
  await addHolder(page, 1, 'Riley Stone', '100');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Publishing is either WORLD or split by country')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Publishing US' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await edit(page, 'Edit master');
  await addHolder(page, 1, 'Harbor Lane Music', '100');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(totalOf(page, 'Master')).toHaveText('100.00%');
  await expect(
    page.getByRole('table', { name: 'Master' }).getByRole('row', { name: /Harbor Lane Music/ }),
  ).toBeVisible();
});
