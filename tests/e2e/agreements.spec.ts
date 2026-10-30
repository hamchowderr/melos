import { expect, type Page, test } from '@playwright/test';
import {
  AUTH_REDIRECT,
  activeOrganizationId,
  insertWorkspaceRows,
  setMemberRole,
  signUpWithWorkspace,
} from './support';

const SONG = '/catalog/compositions/cmp_TIDE';
const dialog = (page: Page) => page.getByRole('dialog');
const record = (page: Page) => page.getByRole('button', { name: 'Record agreement' });

/** Setup rows (D-9): the self party and Harbor Lane Music each hold half of the publishing. */
async function addSong(page: Page) {
  const at = new Date().toISOString();
  const stamps = { created_at: at, updated_at: at };
  const party = (id: string, display_name: string) => ({
    ...{ id, party_kind: 'organization', display_name, ...stamps },
  });
  const publisher = (id: string, party: string) => ({
    ...{ id, composition_id: 'cmp_TIDE', publisher_party_id: party, share_bp: 5000, ...stamps },
  });
  await insertWorkspaceRows(page, {
    parties: [party('pty_SELF', 'Northlight Songs'), party('pty_HARBOR', 'Harbor Lane Music')],
    workspace_self_parties: [
      { side: 'publishing', party_id: 'pty_SELF', party_kind: 'organization', updated_at: at },
    ],
    compositions: [{ id: 'cmp_TIDE', title: 'Tide Song', ...stamps }],
    publishing_interests: [
      publisher('pub_SELF', 'pty_SELF'),
      publisher('pub_HARBOR', 'pty_HARBOR'),
    ],
  });
}

test('melos-rpr.47: an owner records an agreement and attests a share backed by it', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Deals');
  await addSong(page);
  await page.goto(SONG);

  await expect(async () => {
    await record(page).click();
    await expect(dialog(page)).toBeVisible({ timeout: 1_000 });
  }).toPass(AUTH_REDIRECT);
  await dialog(page).getByLabel('Agreement title').fill('Harbor admin deal');
  await dialog(page).getByLabel('Counterparty').selectOption({ label: 'Harbor Lane Music' });
  await dialog(page).getByLabel('Effective on').fill('2026-09-01');
  await dialog(page).getByLabel('Expires on').fill('2026-08-01');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(
    dialog(page).getByText('The expiry date is before the effective date.'),
  ).toBeVisible();
  await dialog(page).getByLabel('Expires on').fill('2028-08-31');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toHaveCount(0);

  const harbor = page.getByRole('table', { name: 'Publishing WORLD' }).getByRole('row', {
    name: /Harbor Lane Music/,
  });
  await harbor
    .getByLabel('Agreement for Harbor Lane Music')
    .selectOption({ label: 'Harbor admin deal' });
  await harbor.getByRole('button', { name: 'Attest Harbor Lane Music' }).click();
  await expect(harbor.getByText('Backed by Harbor admin deal')).toBeVisible();
  await page.reload();
  await expect(harbor.getByText('Backed by Harbor admin deal')).toBeVisible();

  await setMemberRole(await activeOrganizationId(page), 'viewer');
  await page.reload();
  await expect(harbor).toBeVisible();
  await expect(record(page)).toHaveCount(0);
});
