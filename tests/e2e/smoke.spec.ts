import { expect, test } from '@playwright/test';

test('sign up, sign in, create a workspace, and render the ping tool in chat', async ({ page }) => {
  const stamp = Date.now();
  const email = `smoke-${stamp}@example.test`;
  const password = 'smoke-password-123';

  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Smoke Test');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/workspaces\/new$/);

  await page.getByLabel('Workspace name').fill(`Smoke Records ${stamp}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(`${new URL(page.url()).origin}/`);

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
