import { expect, test } from '@playwright/test';
import {
  AUTH_REDIRECT,
  activeOrganizationId,
  lockWorkspaceDatabase,
  setWorkspaceStatus,
  signInAsJordan,
  signUpWithWorkspace,
} from './support';

// A read spec on the seeded Northstar catalog (D-9), sorted by normalized title (§3.5).
test('melos-rpr.2: Jordan opens Catalog: 5 songs with their primary artists', async ({ page }) => {
  await signInAsJordan(page);
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  const catalogLink = nav.getByRole('link', { name: 'Catalog' });
  await catalogLink.click();
  // A cold server renders /catalog alongside the nav's prefetches; 5s is too tight.
  await expect(page).toHaveURL(/\/catalog$/, AUTH_REDIRECT);
  await expect(catalogLink).toHaveAttribute('aria-current', 'page');

  const table = page.getByRole('table');
  const headers = table.getByRole('columnheader');
  await expect(headers).toHaveText([
    ...['Title', 'Primary artists', 'ISWC', 'ISRC', 'Readiness', 'Recordings'],
  ]);
  const rows = table.locator('tbody').getByRole('row');
  // Readiness follows EXPECTED.md §2: Neon Static and Ocean Blue are neither one-stop nor sync ready.
  const ready = /^One Stop Ready\s*Sync ready$/;
  const notReady = /^Not one-stop ready\s*Not sync ready$/;
  const songs: [string | RegExp, string, string, string, RegExp][] = [
    ['Home Again', 'Jordan Taylor', 'T-900.000.004-0', 'US-DMO-26-00004', ready],
    ['Midnight Drive', 'Jordan Taylor', 'T-900.000.001-0', 'US-DMO-26-00001', ready],
    // Alex Ramirez is the primary artist; Jordan Taylor is featured.
    ['Neon Static', 'Alex Ramirez', 'T-900.000.003-0', 'US-DMO-26-00003', notReady],
    // Ocean Blue's recording has no ISRC.
    ['Ocean Blue', 'Jordan Taylor', 'T-900.000.002-0', '', notReady],
    [
      /^Paper Planes at 2AM\s*Also known as Paper Planes$/,
      'Jordan Taylor',
      'T-900.000.005-0',
      'US-DMO-26-00005',
      ready,
    ],
  ];
  await expect(rows).toHaveCount(songs.length);
  for (const [index, [title, artists, iswc, isrc, readiness]] of songs.entries()) {
    await expect(rows.nth(index).getByRole('cell')).toHaveText([
      ...[title, artists, iswc, isrc, readiness, '1'],
    ]);
  }

  // Sorting by title descending puts Paper Planes first; a row click opens its side panel.
  const titleSort = headers.getByRole('button', { name: 'Title' });
  await titleSort.click();
  await titleSort.click();
  await expect(headers.first()).toHaveAttribute('aria-sort', 'descending');
  await expect(rows.first().getByRole('cell').first()).toContainText('Paper Planes at 2AM');
  await rows.filter({ hasText: 'Neon Static' }).getByRole('cell').nth(1).click();
  const panel = page.getByRole('dialog', { name: 'Neon Static' });
  await expect(panel).toContainText('Alex Ramirez');
  await expect(panel).toContainText('US-DMO-26-00003');
  await panel.getByRole('link', { name: 'Open song' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Neon Static', AUTH_REDIRECT);
});

test('melos-rpr.2: a new workspace shows the empty catalog', async ({ page }) => {
  await signUpWithWorkspace(page, 'Blank');
  await page.getByRole('link', { name: 'Catalog' }).click();
  await expect(page).toHaveURL(/\/catalog$/, AUTH_REDIRECT);
  await expect(page.getByText('No songs yet')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('melos-rpr.2: a failed workspace shows the not-ready screen in Catalog', async ({ page }) => {
  await signUpWithWorkspace(page, 'Stalled');
  await setWorkspaceStatus(await activeOrganizationId(page), 'failed');
  await page.goto('/catalog');
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByTestId('workspace-not-ready')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('melos-rpr.43: an unreachable workspace database shows a recoverable error in Catalog', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Outage');
  const release = await lockWorkspaceDatabase(await activeOrganizationId(page));
  try {
    await page.goto('/catalog');
    await expect(page.getByRole('heading', { name: 'This page could not load' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Switch workspace' })).toHaveAttribute(
      'href',
      '/workspaces',
    );
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    // No database error text reaches the page (§7.2).
    await expect(page.getByText(/SQLITE|WorkspaceConnectionError|unavailable:/)).toHaveCount(0);
  } finally {
    release();
  }

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('No songs yet')).toBeVisible();
  await expect(page).toHaveURL(/\/catalog$/);
});

test('melos-rpr.22: Jordan searches the catalog and filters it by readiness', async ({ page }) => {
  await signInAsJordan(page);
  await page.goto('/catalog');
  const search = page.getByRole('search', { name: 'Catalog' });
  const songs = page.getByRole('region', { name: 'Songs' });
  const rows = songs.locator('tbody').getByRole('row');
  const titles = rows.locator('td:first-child a');

  await search.getByLabel('Search songs').fill('Paper Planes');
  await search.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/catalog\?q=Paper\+Planes/);
  await expect(titles).toHaveText(['Paper Planes at 2AM']);

  await search.getByLabel('Search songs').fill('zzzz no such song');
  await search.getByRole('button', { name: 'Search' }).click();
  await expect(songs.getByText('No matching songs')).toBeVisible();
  await expect(rows).toHaveCount(0);

  await search.getByLabel('Search songs').fill('');
  await search.getByLabel('Readiness').selectOption('not_sync_ready');
  await search.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/readiness=not_sync_ready/);
  await expect(titles).toHaveText(['Neon Static', 'Ocean Blue']);
  await expect(page.getByRole('region', { name: 'Releases' })).toBeVisible();
});

test('melos-rpr.48: at phone width Catalog lists each song as a card with no sideways scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsJordan(page);
  await page.goto('/catalog', AUTH_REDIRECT);
  await expect(page.getByRole('table')).toBeHidden();
  const cards = page.getByRole('list', { name: 'Songs' }).getByRole('listitem');
  await expect(cards).toHaveCount(5);
  await expect(cards.nth(2)).toHaveText(
    /^Neon Static\s*Alex Ramirez · 1 recording\s*Not one-stop ready\s*Not sync ready$/,
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
  await cards.getByRole('link', { name: 'Midnight Drive', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Midnight Drive', AUTH_REDIRECT);
});
