import { expect, test } from '@playwright/test';
import { signUpWithWorkspace } from './support';

test('sign up, sign in, create a workspace, and render the ping tool in chat', async ({ page }) => {
  const workspaceName = await signUpWithWorkspace(page, 'Smoke');
  await expect(page.getByTestId('active-workspace-name')).toHaveText(workspaceName);

  const session = await page.request.get('/api/auth/get-session');
  const { session: active } = (await session.json()) as {
    session: { activeOrganizationId: string | null };
  };
  expect(active.activeOrganizationId).toBeTruthy();

  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible({ timeout: 60_000 });
  await input.fill('ping');
  await input.press('Enter');

  await expect(page.getByTestId('ping-card')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('ping-workspace-id')).toHaveText(active.activeOrganizationId ?? '');
  await page.screenshot({ path: 'test-results/ping-card.png', fullPage: true });
});
