import { expect, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, insertWorkspaceRows, signUpWithWorkspace } from './support';

const totalOf = (page: Page, table: string) =>
  page.getByRole('table', { name: table }).getByTestId('share-total');
const fill = (page: Page) => page.getByRole('button', { name: 'Fill with my ownership' });

test('melos-rpr.36: Fill with my ownership fills an empty song (RGT-E2E-008)', async ({ page }) => {
  await signUpWithWorkspace(page, 'Owned');
  const at = new Date().toISOString();
  const stamps = { created_at: at, updated_at: at };
  const party = (id: string, party_kind: string, display_name: string) => ({
    ...{ id, party_kind, display_name, ...stamps },
  });
  const self = (side: string, party_id: string, party_kind: string) => ({
    ...{ side, party_id, party_kind, updated_at: at },
  });
  await insertWorkspaceRows(page, {
    parties: [
      party('pty_RILEY', 'person', 'Riley Stone'),
      party('pty_HARBOR', 'organization', 'Harbor Lane Music'),
    ],
    workspace_self_parties: [
      self('writer', 'pty_RILEY', 'person'),
      self('publishing', 'pty_HARBOR', 'organization'),
      self('master', 'pty_HARBOR', 'organization'),
    ],
    compositions: [{ id: 'cmp_OWN', title: 'Own Song', ...stamps }],
    recordings: [{ id: 'rec_OWN', composition_id: 'cmp_OWN', title: 'Own Song', ...stamps }],
  });
  await page.goto('/catalog/compositions/cmp_OWN');

  await expect(async () => {
    await fill(page).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1_000 });
  }).toPass(AUTH_REDIRECT);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Riley Stone: writer (songwriter) 100%')).toBeVisible();
  await expect(dialog.getByText('Harbor Lane Music: publishing, World 100%')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(totalOf(page, 'Writers')).toHaveText('100.00%');
  await expect(totalOf(page, 'Publishing WORLD')).toHaveText('100.00%');
  await expect(totalOf(page, 'Master')).toHaveText('100.00%');
  // Every set now has rows, writers included, so there is nothing left to fill.
  await expect(fill(page)).toBeDisabled();
});
