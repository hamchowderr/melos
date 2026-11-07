import { expect, type Page, test } from '@playwright/test';
import { insertWorkspaceRows, signInAsJordan, signUpWithWorkspace } from './support';

async function ask(page: Page, prompt: string) {
  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible({ timeout: 60_000 });
  await input.fill(prompt);
  await input.press('Enter');
}

// fixtures/aimock/read-sequences.json: searchMusic, then getMusicWorkspace, then a short answer.
test('melos-2xl.1: searchMusic renders its song grid from the full result (U-03)', async ({
  page,
}) => {
  await signInAsJordan(page);
  await ask(page, 'show me midnight drive');

  const grid = page.getByRole('region', { name: 'Song search results' });
  await expect(grid).toBeVisible({ timeout: 60_000 });
  const song = grid.getByRole('listitem').filter({ hasText: 'Midnight Drive' });
  await expect(song.getByRole('link', { name: 'Midnight Drive' })).toHaveAttribute(
    'href',
    /^\/catalog\/compositions\//,
  );
  // The ISWC and readiness are not in the model summary (§3.6): the renderer got the full DTO.
  await expect(song).toContainText('ISWC T-900.000.001-0');
  await expect(song.getByTestId('readiness')).toContainText('One Stop Ready');
  await expect(page.getByText('Here is Midnight Drive.')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: 'test-results/chat-song-grid.png' });
});

// READ-VS-001 (SA Gate C): searchMusic, then getMusicWorkspace, renders MusicWorkspaceCard.
test('READ-VS-001: "show me midnight drive" renders its song card with tenant data', async ({
  page,
}) => {
  await signInAsJordan(page);
  await ask(page, 'show me midnight drive');

  const card = page.getByRole('region', { name: 'Song', exact: true });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText('Midnight Drive');
  await expect(card).toContainText('Jordan Taylor');
  await expect(card).toContainText('T-900.000.001-0');
  const recording = card.getByRole('list', { name: 'Recordings' }).getByRole('listitem');
  await expect(recording).toHaveCount(1);
  await expect(recording).toContainText('US-DMO-26-00001');
  await expect(recording.getByTestId('readiness')).toContainText('One Stop Ready');
  await expect(card.getByRole('link', { name: 'Open song' })).toHaveAttribute(
    'href',
    /^\/catalog\/compositions\//,
  );
  await page.screenshot({ path: 'test-results/chat-song-card.png' });
});

// fixtures/aimock/read-sequences.json: getRightsSummary on Midnight Drive's composition.
test('melos-2xl.3: getRightsSummary renders the read-only rights panel', async ({ page }) => {
  await signInAsJordan(page);
  await ask(page, 'who wrote this');

  const rights = page.getByRole('region', { name: 'Rights' });
  await expect(rights).toBeVisible({ timeout: 60_000 });
  const writers = rights.getByRole('table', { name: 'Writers' });
  await expect(writers.getByRole('row', { name: /Jordan Taylor/ })).toContainText('100.00%');
  await expect(rights.getByRole('table', { name: 'Master' }).getByTestId('share-total')).toHaveText(
    '100.00%',
  );
  // Read only: the chat shows no editors.
  await expect(rights.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('Here are the writers of Midnight Drive.')).toBeVisible();
  await page.screenshot({ path: 'test-results/chat-rights.png' });
});

// fixtures/aimock/read-sequences.json: getReadinessIssues with onlyNotReady.
test('melos-2xl.4: getReadinessIssues renders the readiness checklist with its panel', async ({
  page,
}) => {
  await signInAsJordan(page);
  await ask(page, 'not ready for sync');

  const card = page.getByRole('region', { name: 'Rights readiness' });
  await expect(card).toBeVisible({ timeout: 60_000 });
  const recordings = card.getByRole('table', { name: 'Recordings' });
  // EXPECTED.md §6 DEMO-003, by title.
  await expect(recordings.locator('tbody tr td:first-child')).toHaveText([
    'Neon Static',
    'Ocean Blue',
  ]);
  await recordings.getByRole('row', { name: 'Ocean Blue readiness' }).press('Enter');
  await expect(
    page
      .getByRole('dialog', { name: 'Ocean Blue' })
      .getByRole('list', { name: 'Ocean Blue issues' }),
  ).toContainText('MISSING_ISRC');
  await expect(page.getByText('These recordings are not ready for sync.')).toBeVisible();
});

// fixtures/aimock/ownership-proposal.json: proposeDefaultOwnership on an empty song.
test('melos-2xl.5: proposeDefaultOwnership renders the proposal and saves nothing', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Proposal');
  const at = new Date().toISOString();
  const stamps = { created_at: at, updated_at: at };
  const self = (side: string, party_id: string, party_kind: string) => ({
    ...{ side, party_id, party_kind, updated_at: at },
  });
  await insertWorkspaceRows(page, {
    parties: [
      { id: 'pty_RILEY', party_kind: 'person', display_name: 'Riley Stone', ...stamps },
      {
        id: 'pty_HARBOR',
        party_kind: 'organization',
        display_name: 'Harbor Lane Music',
        ...stamps,
      },
    ],
    workspace_self_parties: [
      self('writer', 'pty_RILEY', 'person'),
      self('publishing', 'pty_HARBOR', 'organization'),
      self('master', 'pty_HARBOR', 'organization'),
    ],
    compositions: [{ id: 'cmp_OWN', title: 'Own Song', ...stamps }],
    recordings: [{ id: 'rec_OWN', composition_id: 'cmp_OWN', title: 'Own Song', ...stamps }],
  });
  await page.goto('/');
  await ask(page, 'propose my default ownership');

  const card = page.getByRole('region', { name: 'Proposed ownership' });
  await expect(card).toBeVisible({ timeout: 60_000 });
  const shares = card.getByRole('list', { name: 'Proposed shares' }).getByRole('listitem');
  await expect(shares).toHaveText([
    /^Writer\s*Riley Stone · songwriter\s*100\.00%$/,
    /^Publishing\s*Harbor Lane Music · World\s*100\.00%$/,
    /^Master\s*Harbor Lane Music\s*100\.00%$/,
  ]);
  await expect(card).toContainText('Nothing is saved');

  // Proposing writes nothing: the song still has no writers.
  await page.goto('/catalog/compositions/cmp_OWN');
  await expect(page.getByRole('table', { name: 'Writers' }).getByTestId('share-total')).toHaveText(
    '0.00%',
  );
});

// fixtures/aimock/focus.json: "who wrote it" calls getRightsSummary only when the system
// message names Midnight Drive as the focused entity; otherwise the model asks which song.
test('melos-2xl.6: the song card sets the focused entity that "it" resolves to (U-04)', async ({
  page,
}) => {
  await signInAsJordan(page);
  await ask(page, 'who wrote it');
  await expect(page.getByText('Which song do you mean?')).toBeVisible({ timeout: 60_000 });

  await ask(page, 'show me midnight drive');
  await expect(page.getByRole('region', { name: 'Song', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Here is Midnight Drive.')).toBeVisible({ timeout: 60_000 });

  await ask(page, 'who wrote it');
  const rights = page.getByRole('region', { name: 'Rights' });
  await expect(rights).toBeVisible({ timeout: 60_000 });
  await expect(
    rights.getByRole('table', { name: 'Writers' }).getByRole('row', { name: /Jordan Taylor/ }),
  ).toContainText('100.00%');
  await expect(page.getByText('Here are the writers of the focused song.')).toBeVisible();
});

// fixtures/aimock/contacts.json: searchContacts, then getContact (melos-ajt.12).
test('melos-ajt.12: searchContacts and getContact render ContactGrid and ContactCard', async ({
  page,
}) => {
  await signInAsJordan(page);
  await ask(page, 'who is rebecca carter');

  const grid = page.getByRole('region', { name: 'Contacts', exact: true });
  await expect(grid.getByRole('link', { name: 'Rebecca Carter' })).toBeVisible({ timeout: 60_000 });
  // The email is not in the model summary (§3.6): the grid got the full DTO.
  await expect(grid).toContainText('rebecca@cartersync.example');
  const card = page.getByRole('region', { name: 'Contact', exact: true });
  await expect(card.getByRole('list', { name: 'Pitched songs' })).toContainText(
    'Paper Planes at 2AM',
  );
  await expect(page.getByText('Rebecca Carter is a music supervisor')).toBeVisible({
    timeout: 60_000,
  });
});
