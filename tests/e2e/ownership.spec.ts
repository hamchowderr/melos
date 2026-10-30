import { expect, type Page, test } from '@playwright/test';
import {
  AUTH_REDIRECT,
  activeOrganizationId,
  insertWorkspaceRows,
  setMemberRole,
  signInAsJordan,
  signUpWithWorkspace,
} from './support';

const SIDES = ['Writer', 'Publishing', 'Master'];
const picker = (page: Page, side: string) => page.getByLabel(side, { exact: true });

/** Setup rows for a write spec (D-9): a person and two organizations in the active workspace. */
async function addParties(page: Page) {
  const at = new Date().toISOString();
  const party = (id: string, party_kind: string, display_name: string) => ({
    ...{ id, party_kind, display_name, created_at: at, updated_at: at },
  });
  await insertWorkspaceRows(page, {
    parties: [
      party('pty_RILEY', 'person', 'Riley Stone'),
      party('pty_HARBOR', 'organization', 'Harbor Lane Music'),
      party('pty_TIDE', 'organization', 'Tidewater Records'),
    ],
  });
}

/** Opens a picker, checks the parties it lists and picks one; a click before hydration retries. */
const choose = (page: Page, side: string, listed: string[], name: string) =>
  expect(async () => {
    await picker(page, side).click();
    await expect(page.getByRole('option')).toHaveText(listed, { timeout: 1_000 });
    await page.getByRole('option', { name }).click();
    await expect(picker(page, side)).toHaveValue(name, { timeout: 1_000 });
  }).toPass(AUTH_REDIRECT);

// A read spec on the seeded Northstar self parties (D-9).
test('melos-rpr.11: Jordan opens Settings, then Ownership, and sees the Northstar self parties', async ({
  page,
}) => {
  await signInAsJordan(page);
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Settings' })
    .click();
  const settings = page.getByRole('navigation', { name: 'Settings' });
  await settings.getByRole('link', { name: 'Ownership' }).click();
  await expect(page).toHaveURL(/\/settings\/ownership$/, AUTH_REDIRECT);
  await expect(settings.getByRole('link', { name: 'Ownership' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const names = ['Jordan Taylor', 'Silverline Songs', 'Silverline Songs'];
  for (const [i, side] of SIDES.entries()) await expect(picker(page, side)).toHaveValue(names[i]);
});

test('melos-rpr.11: an owner sets all three sides in a fresh workspace, and a viewer sees them read-only', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Ownership');
  await addParties(page);
  await page.goto('/settings/ownership');
  const all = ['Harbor Lane Music', 'Riley Stone', 'Tidewater Records'];
  // The writer side lists people only (§4.2).
  await choose(page, 'Writer', ['Riley Stone'], 'Riley Stone');
  await choose(page, 'Publishing', all, 'Harbor Lane Music');
  await choose(page, 'Master', all, 'Tidewater Records');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');

  const saved = ['Riley Stone', 'Harbor Lane Music', 'Tidewater Records'];
  await page.reload();
  for (const [i, side] of SIDES.entries()) await expect(picker(page, side)).toHaveValue(saved[i]);

  await setMemberRole(await activeOrganizationId(page), 'viewer');
  await page.reload();
  await expect(page.locator('dd')).toHaveText(saved);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
});
