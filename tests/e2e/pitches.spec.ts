import { expect, test } from '@playwright/test';
import { signInAsJordan } from './support';

// melos-ajt.17: /pitches on the seeded Northstar workspace (docs/fixtures/EXPECTED.md).

test('CRM-E2E-003: Jordan filters pitches by status', async ({ page }) => {
  await signInAsJordan(page);
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Pitches' })
    .click();
  await expect(page.getByRole('heading', { name: 'Pitches' })).toBeVisible();
  const list = page.getByRole('table', { name: 'Pitch List' });
  await expect(list.getByRole('row', { name: 'Paper Planes at 2AM to Theo Grant' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Filter by Status' })
    .getByRole('link', { name: 'Awaiting reply' })
    .click();
  await expect(page).toHaveURL(/status=awaiting_reply/);
  await expect(
    list.getByRole('row', { name: 'Paper Planes at 2AM to Rebecca Carter' }),
  ).toBeVisible();
  await expect(list.getByRole('row', { name: 'Paper Planes at 2AM to Theo Grant' })).toHaveCount(0);
  await expect(list.getByRole('row')).toHaveCount(3);
});

// The one write: Malik's passed cell is archived, which keeps it not due and heard (EXPECTED §3, §4).
test('CRM-E2E-002: a status change asks to confirm a terminal move and adds its event', async ({
  page,
}) => {
  await signInAsJordan(page);
  await page.goto('/pitches?status=passed');
  await page.getByRole('row', { name: 'Paper Planes at 2AM to Malik Johnson' }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('list', { name: 'Songs in This Pitch' })).toContainText('Passed');
  await panel
    .getByRole('combobox', { name: 'New status for Paper Planes at 2AM' })
    .selectOption('archived');
  await panel.getByRole('button', { name: 'Save' }).click();
  await panel.getByRole('button', { name: 'Confirm: Archived' }).click();
  await expect(panel.getByRole('list', { name: 'Timeline' }).locator('li').last()).toContainText(
    'status changed · Passed to Archived',
  );
  await expect(panel.getByRole('list', { name: 'Songs in This Pitch' })).toContainText('Archived');
});
