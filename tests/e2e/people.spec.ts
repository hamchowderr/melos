import { expect, test } from '@playwright/test';
import { AUTH_REDIRECT, signInAsJordan } from './support';

const THEO_GRANT = /\/people\/pty_01KZ45YEP05X66A2C5QX8249JJ$/;
const REBECCA_CARTER = /\/people\/pty_01KZ45Y6W0QJ76S7EXD971BEYF$/;

// A read spec on the seeded Northstar parties (D-9): 7 people and 7 organizations.
test('melos-rpr.6, melos-rpr.45: Jordan opens People: both tabs, Theo Grant, then Rebecca Carter', async ({
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
  // A click before hydration switches nothing, so each click retries until a name only that
  // tab lists is its first row.
  const openTab = (name: string, firstName: string) =>
    expect(async () => {
      await page.getByRole('tab', { name }).click();
      const first = rows.first().getByRole('cell').first();
      await expect(first).toHaveText(firstName, { timeout: 1_000 });
    }).toPass(AUTH_REDIRECT);
  await openTab('Organizations', 'Blue Lantern Studios');
  await expect(rows).toHaveCount(7);
  await expect(table.getByRole('columnheader')).toHaveText([
    ...['Name', 'Type', 'People', 'Primary email'],
  ]);
  const organization = (name: string) => rows.filter({ hasText: name });
  // No demo organization has an email.
  await expect(organization('Carter Sync Agency').getByRole('cell')).toHaveText([
    ...['Carter Sync Agency', 'Sync agency', 'Rebecca Carter', ''],
  ]);
  await expect(organization('Blue Lantern Studios').getByRole('cell')).toHaveText([
    ...['Blue Lantern Studios', 'Other', 'Theo Grant', ''],
  ]);
  await openTab('People', 'Alex Ramirez');
  await expect(table.getByRole('columnheader')).toHaveText([
    ...['Name', 'Primary email', 'Company', 'Contact roles'],
  ]);
  await expect(rows).toHaveCount(7);
  const theo = rows.filter({ hasText: 'Theo Grant' });
  const cells = [
    'Theo Grant',
    'theo@bluelantern.example',
    'Blue Lantern Studios',
    'Music supervisor',
  ];
  await expect(theo.getByRole('cell')).toHaveText(cells);

  await theo.getByRole('link', { name: 'Theo Grant' }).click();
  await expect(page).toHaveURL(THEO_GRANT, AUTH_REDIRECT);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Theo Grant');
  await expect(page.getByText('Music supervisor')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Blue Lantern Studios' })).toBeVisible();

  const missing = await page.goto('/people/pty_UNKNOWN', AUTH_REDIRECT);
  expect(missing?.status()).toBe(404);

  // A person's name in the Organizations tab opens their page.
  await page.goto('/people', AUTH_REDIRECT);
  await openTab('Organizations', 'Blue Lantern Studios');
  const carter = organization('Carter Sync Agency');
  await carter.getByRole('link', { name: 'Rebecca Carter' }).click();
  await expect(page).toHaveURL(REBECCA_CARTER, AUTH_REDIRECT);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rebecca Carter');
});
