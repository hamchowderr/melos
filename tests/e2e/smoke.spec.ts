import { expect, test } from '@playwright/test';
import { signIn, signUp, signUpWithWorkspace } from './support';

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
  await expect(page.getByTestId('ping-organization-id')).toHaveText(
    active.activeOrganizationId ?? '',
  );
  await expect(page.getByTestId('ping-workspace-id')).toHaveText(/^ws_[0-9A-HJKMNP-TV-Z]{26}$/);
  await page.screenshot({ path: 'test-results/ping-card.png', fullPage: true });
});

test('ONB-E2E-001: a workspace cannot be created without choosing a type', async ({ page }) => {
  await signIn(page, await signUp(page, 'NoType'));
  await page.getByLabel('Workspace Name').fill(`NoType Records ${Date.now()}`);
  await page.getByRole('button', { name: 'Create Workspace' }).click();
  await expect(page).toHaveURL(/\/workspaces\/new$/);
  const radio = page.getByRole('radio', { name: 'Songwriter or Artist' });
  expect(await radio.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  await page.screenshot({ path: 'test-results/workspace-type-picker.png', fullPage: true });
});
