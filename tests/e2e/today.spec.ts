import { expect, test } from '@playwright/test';
import { signInAsJordan } from './support';

// melos-ajt.18: /today on the seed date (docs/fixtures/EXPECTED.md DEMO-010 §4 queue).

test('CRM-E2E-005: Today lists the follow-ups due in priority order', async ({ page }) => {
  await signInAsJordan(page);
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Today' })
    .click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  const queue = page.getByRole('table', { name: 'Follow-up queue' });
  // Paper Planes with Rebecca leads the queue until a send moves its follow-up (DEMO-007).
  const rows = queue.getByRole('row', { name: / to / });
  await expect(rows.filter({ hasNotText: 'Paper Planes at 2AM' })).toHaveText([
    /Midnight Drive.*Maya Chen.*Awaiting reply/,
    /Midnight Drive.*Rebecca Carter.*Pitched/,
    /Neon Static.*Maya Chen/,
    /Neon Static.*Rebecca Carter/,
  ]);
  await expect(queue.getByRole('row', { name: 'Paper Planes at 2AM to Theo Grant' })).toHaveCount(
    0,
  );

  await expect(page.getByRole('region', { name: 'Ready to pitch' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recent replies' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Readiness issues' })).toBeVisible();
  await queue.getByRole('link', { name: 'Midnight Drive' }).first().click();
  await expect(page).toHaveURL(/\/catalog\/compositions\//);
});
