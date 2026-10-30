import { expect, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, insertWorkspaceRows, signUpWithWorkspace } from './support';

const dialog = (page: Page) => page.getByRole('dialog');

/** Opens a dialog from its button; a click before hydration retries. */
const open = (page: Page, name: string) =>
  expect(async () => {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(dialog(page)).toBeVisible({ timeout: 1_000 });
  }).toPass(AUTH_REDIRECT);

test('melos-rpr.39: an owner credits a featured artist and tags a genre (CAT-003, CAT-006)', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Credits');
  const at = new Date().toISOString();
  const stamps = { created_at: at, updated_at: at };
  const party = (id: string, display_name: string) => ({
    ...{ id, party_kind: 'person', display_name, ...stamps },
  });
  await insertWorkspaceRows(page, {
    parties: [party('pty_RILEY', 'Riley Stone'), party('pty_ALEX', 'Alex Ramirez')],
    artist_aliases: [
      {
        id: 'als_ALEX',
        party_id: 'pty_ALEX',
        alias_name: 'DJ Alex',
        alias_type: 'stage_name',
        is_primary: 1,
        created_at: at,
      },
    ],
    compositions: [{ id: 'cmp_DUSK', title: 'Dusk Run', ...stamps }],
    recordings: [{ id: 'rec_DUSK', composition_id: 'cmp_DUSK', title: 'Dusk Run', ...stamps }],
  });
  await page.goto('/catalog/compositions/cmp_DUSK');

  await open(page, 'Edit artists');
  await dialog(page).getByRole('button', { name: 'Add artist' }).click();
  await dialog(page).getByLabel('Artist 1 party').selectOption({ label: 'Riley Stone' });
  await dialog(page).getByRole('button', { name: 'Add artist' }).click();
  await dialog(page).getByLabel('Artist 2 party').selectOption({ label: 'Alex Ramirez' });
  await dialog(page).getByLabel('Artist 2 role').selectOption('featured');
  await dialog(page).getByLabel('Artist 2 alias').selectOption({ label: 'DJ Alex' });
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toHaveCount(0);
  const chips = page.getByRole('list', { name: 'Artists' }).getByRole('listitem');
  await expect(chips).toHaveText(['Riley Stone', 'feat. DJ Alex']);

  await open(page, 'Edit terms');
  await dialog(page).getByLabel('Genre').fill('Synth Pop, Electronic');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByText('Electronic, Synth Pop')).toBeVisible();

  await page.goto('/catalog?q=Synth');
  await expect(
    page.getByRole('region', { name: 'Songs' }).getByRole('link', { name: 'Dusk Run' }),
  ).toBeVisible();
});
