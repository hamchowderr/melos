import { expect, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, insertWorkspaceRows, signUpWithWorkspace } from './support';

const SONG = '/catalog/compositions/cmp_TIDE';
const issues = (page: Page) => page.getByRole('list', { name: 'Issues' });
const contacts = (page: Page) => page.getByRole('list', { name: 'Licensing contacts' });

/**
 * Setup rows (D-9): the workspace's self party holds 50% of the publishing and all of the master,
 * another publisher holds the other 50%, and one writer holds 100% (RGT-E2E-005).
 */
async function addSong(page: Page) {
  const at = new Date().toISOString();
  const stamps = { created_at: at, updated_at: at };
  const party = (id: string, display_name: string) => ({
    ...{ id, party_kind: 'organization', display_name, ...stamps },
  });
  const self = (side: string) => ({
    ...{ side, party_id: 'pty_SELF', party_kind: 'organization', updated_at: at },
  });
  const publisher = (id: string, party: string) => ({
    ...{ id, composition_id: 'cmp_TIDE', publisher_party_id: party, share_bp: 5000, ...stamps },
  });
  await insertWorkspaceRows(page, {
    parties: [
      party('pty_SELF', 'Northlight Songs'),
      party('pty_HARBOR', 'Harbor Lane Music'),
      { ...party('pty_RILEY', 'Riley Stone'), party_kind: 'person' },
    ],
    workspace_self_parties: [self('publishing'), self('master')],
    compositions: [{ id: 'cmp_TIDE', title: 'Tide Song', ...stamps }],
    composition_contributors: [
      {
        id: 'ctr_RILEY',
        composition_id: 'cmp_TIDE',
        party_id: 'pty_RILEY',
        writer_share_bp: 10_000,
        ...stamps,
      },
    ],
    recordings: [{ id: 'rec_TIDE', composition_id: 'cmp_TIDE', title: 'Tide Song', ...stamps }],
    publishing_interests: [
      publisher('pub_SELF', 'pty_SELF'),
      publisher('pub_HARBOR', 'pty_HARBOR'),
    ],
    master_interests: [
      {
        id: 'mas_SELF',
        recording_id: 'rec_TIDE',
        owner_party_id: 'pty_SELF',
        share_bp: 10_000,
        ...stamps,
      },
    ],
  });
}

test('melos-rpr.32: attesting the other publisher makes the song One Stop Ready (RGT-E2E-005)', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Licensing');
  await addSong(page);
  await page.goto(SONG);
  await expect(issues(page)).toContainText('PUBLISHING_NOT_CONTROLLED');
  await expect(issues(page)).toContainText('NO_LICENSING_CONTACT');

  await expect(async () => {
    await page.getByRole('button', { name: 'Attest Harbor Lane Music' }).click();
    await expect(page.getByRole('button', { name: 'Clear Harbor Lane Music' })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass(AUTH_REDIRECT);
  await expect(page.getByText('PUBLISHING_NOT_CONTROLLED')).toHaveCount(0);
  await expect(page.getByText('NO_LICENSING_CONTACT')).toHaveCount(0);
  await expect(page.getByText('One Stop Ready').first()).toBeVisible();
  // P-28: the master self party stands in as the implicit contact.
  await expect(contacts(page).getByRole('listitem')).toHaveText(['Northlight SongsImplicit']);

  await page.getByRole('button', { name: 'Edit licensing contacts' }).click();
  await page.getByRole('button', { name: 'Add contact' }).click();
  await page.getByLabel('Contact 1').click();
  await page.getByRole('option', { name: 'Harbor Lane Music' }).click();
  await page
    .getByRole('form', { name: 'Edit licensing contacts' })
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(contacts(page).getByRole('listitem')).toHaveText(['Harbor Lane Music']);
  await page.reload();
  await expect(contacts(page).getByRole('listitem')).toHaveText(['Harbor Lane Music']);
});
