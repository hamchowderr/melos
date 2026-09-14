import { expect, test } from '@playwright/test';
import {
  activeOrganizationId,
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
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(catalogLink).toHaveAttribute('aria-current', 'page');

  const table = page.getByRole('table');
  const headers = table.getByRole('columnheader');
  await expect(headers).toHaveText(['Title', 'Primary artists', 'Recordings']);
  const rows = table.locator('tbody').getByRole('row');
  const songs: [string | RegExp, string][] = [
    ['Home Again', 'Jordan Taylor'],
    ['Midnight Drive', 'Jordan Taylor'],
    // Alex Ramirez is the primary artist; Jordan Taylor is featured.
    ['Neon Static', 'Alex Ramirez'],
    ['Ocean Blue', 'Jordan Taylor'],
    [/^Paper Planes at 2AM\s*Also known as Paper Planes$/, 'Jordan Taylor'],
  ];
  await expect(rows).toHaveCount(songs.length);
  for (const [index, [title, artists]] of songs.entries()) {
    await expect(rows.nth(index).getByRole('cell')).toHaveText([title, artists, '1']);
  }
});

test('melos-rpr.2: a new workspace shows the empty catalog', async ({ page }) => {
  await signUpWithWorkspace(page, 'Blank');
  await page.getByRole('link', { name: 'Catalog' }).click();
  await expect(page).toHaveURL(/\/catalog$/);
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
