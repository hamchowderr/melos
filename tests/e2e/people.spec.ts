import { expect, test } from '@playwright/test';
import { AUTH_REDIRECT, signInAsJordan } from './support';

const THEO_GRANT = /\/people\/pty_01KZ45YEP05X66A2C5QX8249JJ$/;

// A read spec on the seeded Northstar parties (D-9): 7 people and 7 organizations.
test('melos-rpr.6: Jordan opens People: both tabs, then Theo Grant, a music supervisor', async ({
  page,
}) => {
  await signInAsJordan(page);
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  const peopleLink = nav.getByRole('link', { name: 'People' });
  await peopleLink.click();
  // A cold server renders /people alongside the nav's prefetches; 5s is too tight.
  await expect(page).toHaveURL(/\/people$/, AUTH_REDIRECT);
  await expect(peopleLink).toHaveAttribute('aria-current', 'page');

  const table = page.getByRole('tabpanel').getByRole('table');
  const rows = table.locator('tbody').getByRole('row');
  await page.getByRole('tab', { name: 'Organizations' }).click();
  await expect(rows).toHaveCount(7);
  await expect(rows.first().getByRole('cell').first()).toHaveText('Blue Lantern Studios');
  await page.getByRole('tab', { name: 'People' }).click();
  await expect(table.getByRole('columnheader')).toHaveText([
    ...['Name', 'Primary email', 'Company', 'Contact roles'],
  ]);
  await expect(rows).toHaveCount(7);
  const theo = rows.filter({ hasText: 'Theo Grant' });
  const cells = [
    'Theo Grant',
    'theo@bluelantern.example',
    'Blue Lantern Studios',
    'music_supervisor',
  ];
  await expect(theo.getByRole('cell')).toHaveText(cells);

  await theo.getByRole('link', { name: 'Theo Grant' }).click();
  await expect(page).toHaveURL(THEO_GRANT, AUTH_REDIRECT);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Theo Grant');
  await expect(page.getByText('music_supervisor')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Blue Lantern Studios' })).toBeVisible();

  const missing = await page.goto('/people/pty_UNKNOWN', AUTH_REDIRECT);
  expect(missing?.status()).toBe(404);
});
