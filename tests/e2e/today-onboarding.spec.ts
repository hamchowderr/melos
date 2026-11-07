import { expect, test } from '@playwright/test';
import { signUpWithWorkspace } from './support';

test('ONB-E2E-003: a new workspace shows its checklist on Today until dismissed', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Checklist');
  await page.goto('/today');
  const card = page.getByTestId('onboarding-checklist');
  await expect(card).toContainText('Getting started 0 of 4');
  await expect(card.getByRole('link', { name: /Add or import your first song/ })).toHaveAttribute(
    'href',
    '/catalog',
  );
  await page.screenshot({ path: 'test-results/today-onboarding.png', fullPage: true });
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toBeHidden();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByTestId('onboarding-checklist')).toBeHidden();
});
