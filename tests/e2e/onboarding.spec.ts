import { expect, test } from '@playwright/test';
import { signUpWithWorkspace } from './support';

test('ONB-002: an owner changes the workspace type in Settings', async ({ page }) => {
  await signUpWithWorkspace(page, 'TypeChange');
  await page.goto('/settings');
  const panel = page.getByTestId('workspace-type-panel');
  await expect(panel.getByRole('radio', { name: 'Songwriter or Artist' })).toBeChecked();
  await panel.getByRole('radio', { name: 'Artist Manager' }).check();
  await panel.getByRole('button', { name: 'Save Type' }).click();
  await expect(panel).toContainText('Currently Artist Manager');
  await page.reload();
  await expect(
    page.getByTestId('workspace-type-panel').getByRole('radio', { name: 'Artist Manager' }),
  ).toBeChecked();
  await page.screenshot({ path: 'test-results/settings-workspace-type.png', fullPage: true });
});
