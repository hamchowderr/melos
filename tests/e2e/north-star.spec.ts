import { expect, test } from '@playwright/test';
import { signInAsJordan } from './support';

// melos-ajt.1: Jordan, the owner, reads the weekly North Star on Settings.
test('melos-ajt.1: the owner sees the North Star by week', async ({ page }) => {
  await signInAsJordan(page);
  await page.goto('/settings');
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'North Star' })
    .click();
  const weeks = page.getByRole('table', { name: 'North Star by week' });
  await expect(weeks.getByRole('row', { name: /^Week of \d/ })).toHaveCount(4);
});
