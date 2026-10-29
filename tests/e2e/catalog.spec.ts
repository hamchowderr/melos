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
  await expect(headers).toHaveText(['Title', 'Primary artists', 'Readiness', 'Recordings']);
  const rows = table.locator('tbody').getByRole('row');
  // Readiness follows EXPECTED.md §2: Neon Static and Ocean Blue are neither one-stop nor sync ready.
  const ready = /^One Stop Ready\s*Sync ready$/;
  const notReady = /^Not one-stop ready\s*Not sync ready$/;
  const songs: [string | RegExp, string, RegExp][] = [
    ['Home Again', 'Jordan Taylor', ready],
    ['Midnight Drive', 'Jordan Taylor', ready],
    // Alex Ramirez is the primary artist; Jordan Taylor is featured.
    ['Neon Static', 'Alex Ramirez', notReady],
    ['Ocean Blue', 'Jordan Taylor', notReady],
    [/^Paper Planes at 2AM\s*Also known as Paper Planes$/, 'Jordan Taylor', ready],
  ];
  await expect(rows).toHaveCount(songs.length);
  for (const [index, [title, artists, readiness]] of songs.entries()) {
    await expect(rows.nth(index).getByRole('cell')).toHaveText([title, artists, readiness, '1']);
  }
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
