import { expect, type Locator, type Page, test } from '@playwright/test';
import { AUTH_REDIRECT, signInAsJordan } from './support';

// Read specs on the seeded Northstar catalog (D-9), with ids from docs/fixtures/northstar-demo.json.
const MIDNIGHT_DRIVE = /\/catalog\/compositions\/cmp_01KZ6VFGM03FXFCHY5DDZY6BQT$/;

/** The value a song page card shows for `term`. */
const detail = (card: Locator, term: string) => card.locator(`dt:text-is("${term}") + dd`);
const artists = (card: Locator) =>
  card.getByRole('list', { name: 'Artists' }).getByRole('listitem');

/** Signs in as Jordan and opens a song's page by clicking its title on /catalog. */
async function openFromCatalog(page: Page, title: string): Promise<void> {
  await signInAsJordan(page);
  // A cold server renders the first dynamic page slowly; 5s is too tight.
  await page.goto('/catalog', AUTH_REDIRECT);
  await page.getByRole('table').getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title, AUTH_REDIRECT);
}

test('melos-rpr.5: Midnight Drive opens from Catalog with its identifiers, artist and player', async ({
  page,
}) => {
  await openFromCatalog(page, 'Midnight Drive');
  await expect(page).toHaveURL(MIDNIGHT_DRIVE);
  const composition = page.getByRole('region', { name: 'Composition' });
  await expect(detail(composition, 'ISWC')).toHaveText('T-900.000.001-0');
  const recording = page.getByRole('region', { name: 'Midnight Drive', exact: true });
  await expect(detail(recording, 'ISRC')).toHaveText('US-DMO-26-00001');
  await expect(artists(recording)).toHaveText(['Jordan Taylor']);
  await expect(artists(recording).first()).toHaveAttribute('data-role', 'primary');
  // D-8: the primary link opens its player page, labelled with the preview start.
  const player = recording.getByRole('link', { name: 'Open player · starts 0:42' });
  await expect(player).toHaveAttribute('href', 'https://media.example/midnight-drive');
  await expect(player).toHaveAttribute('target', '_blank');
});

test('melos-rpr.5: Ocean Blue shows Alex Ramirez as featured and no ISRC', async ({ page }) => {
  await openFromCatalog(page, 'Ocean Blue');
  // Ocean Blue is the fixture song with lyrics: the page says they're on file but never shows them.
  const composition = page.getByRole('region', { name: 'Composition' });
  await expect(detail(composition, 'Lyrics')).toHaveText('On file');
  await expect(page.locator('body')).not.toContainText('Salt on the window');
  const recording = page.getByRole('region', { name: 'Ocean Blue', exact: true });
  await expect(artists(recording)).toHaveText(['Jordan Taylor', 'feat. Alex Ramirez']);
  await expect(artists(recording).nth(1)).toHaveAttribute('data-role', 'featured');
  await expect(recording.getByRole('link', { name: 'Open player · starts 0:35' })).toBeVisible();
  // The Midnight Drive test finds the ISRC term in this same card when a recording has one.
  await expect(recording).not.toContainText('ISRC');
});

test('melos-rpr.5: an unknown composition is a 404; a recording opens its composition', async ({
  page,
}) => {
  await signInAsJordan(page);
  const missing = await page.goto('/catalog/compositions/cmp_UNKNOWN', AUTH_REDIRECT);
  expect(missing?.status()).toBe(404);
  await page.goto('/catalog/recordings/rec_01KZ6VFHK8FHF6M5D6DMZSCQAJ');
  await expect(page).toHaveURL(MIDNIGHT_DRIVE);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Midnight Drive');
});

test('melos-rpr.16: Ocean Blue shows publishing WORLD at 85.00% with its readiness issues', async ({
  page,
}) => {
  await openFromCatalog(page, 'Ocean Blue');
  const rights = page.getByRole('region', { name: 'Rights' });
  const world = rights.getByRole('table', { name: 'Publishing WORLD' });
  await expect(world.getByTestId('share-total')).toHaveText('85.00%');
  await expect(world.getByRole('row', { name: /Silverline Songs/ })).toContainText('Self');
  // EXPECTED.md §2: three one-stop codes, then the sync-only code.
  const issues = rights.getByRole('list', { name: 'Issues' }).getByRole('listitem');
  await expect(issues).toHaveText([
    /^PUBLISHING_TOTAL_INCOMPLETE/,
    /^PUBLISHING_NOT_CONTROLLED/,
    /^NO_LICENSING_CONTACT/,
    /^MISSING_ISRC/,
  ]);
  await expect(
    rights.getByRole('heading', { name: 'Licensing contacts' }).locator('..'),
  ).toContainText('None');
  const recording = page.getByRole('region', { name: 'Ocean Blue', exact: true });
  await expect(recording.getByTestId('readiness')).toContainText('Not one-stop ready');
});

test('melos-rpr.16: Midnight Drive is One Stop Ready with Silverline Songs as implicit contact', async ({
  page,
}) => {
  await openFromCatalog(page, 'Midnight Drive');
  const recording = page.getByRole('region', { name: 'Midnight Drive', exact: true });
  await expect(recording.getByTestId('readiness')).toContainText('One Stop Ready');
  const rights = page.getByRole('region', { name: 'Rights' });
  const contacts = rights.getByRole('list', { name: 'Licensing contacts' }).getByRole('listitem');
  await expect(contacts).toHaveText([/^Silverline Songs\s*Implicit$/]);
  await expect(rights.getByRole('list', { name: 'Issues' })).toHaveCount(0);
  await expect(
    rights.getByRole('table', { name: 'Writers' }).getByTestId('share-total'),
  ).toHaveText('100.00%');
});

test('melos-rpr.16: /rights lists Ocean Blue and Neon Static as not ready', async ({ page }) => {
  await signInAsJordan(page);
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Rights' })
    .click();
  await expect(page).toHaveURL(/\/rights$/, AUTH_REDIRECT);
  const recordings = page.getByRole('list', { name: 'Recordings' });
  // EXPECTED.md §6 DEMO-003, by title.
  await expect(recordings.getByRole('heading', { level: 2 })).toHaveText([
    'Neon Static',
    'Ocean Blue',
  ]);
  const ocean = recordings.getByRole('list', { name: 'Ocean Blue issues' }).getByRole('listitem');
  await expect(ocean).toHaveText([
    /^PUBLISHING_TOTAL_INCOMPLETE/,
    /^PUBLISHING_NOT_CONTROLLED/,
    /^NO_LICENSING_CONTACT/,
    /^MISSING_ISRC/,
  ]);

  const filter = page.getByRole('switch', { name: 'Only not ready' });
  await expect(filter).toHaveAttribute('aria-checked', 'true');
  await filter.click();
  await expect(page).toHaveURL(/\/rights\?all=1$/);
  await expect(recordings.getByRole('heading', { level: 2 })).toHaveCount(5);
  await expect(page.getByRole('switch', { name: 'Only not ready' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
});
