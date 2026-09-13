import { expect, test } from '@playwright/test';
import { activeOrganizationId, createWorkspace, pingInChat, signUpWithWorkspace } from './support';

test('AUTH-E2E-001: signed out, / redirects and the agent answers 401', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);

  const id = 'e2e-signed-out';
  const run = { threadId: id, runId: id, messages: [], tools: [], context: [], state: {} };
  for (const cookie of ['', 'better-auth.session_token=forged-token.forged-signature']) {
    const headers = { cookie };
    expect((await request.get('/api/copilotkit/info', { headers })).status()).toBe(401);
    const response = await request.post('/api/copilotkit/agent/melos/run', { headers, data: run });
    expect(response.status()).toBe(401);
  }
});

test('AUTH-E2E-003: tool results follow the newly active workspace', async ({ page }) => {
  const firstName = await signUpWithWorkspace(page, 'Switch');
  const firstId = await activeOrganizationId(page);

  const secondName = `${firstName} Two`;
  await page.goto('/workspaces/new');
  await createWorkspace(page, secondName);
  const secondId = await activeOrganizationId(page);
  expect(secondId).not.toBe(firstId);
  await pingInChat(page);
  await expect(page.getByTestId('ping-workspace-id')).toHaveText(secondId);
  await expect(page.getByTestId('ping-workspace-role')).toHaveText('owner');

  // No workspace switcher exists yet; switch through the endpoint the auth client calls.
  // Better Auth refuses a cookie-bearing POST without an Origin header.
  const switched = await page.request.post('/api/auth/organization/set-active', {
    headers: { origin: new URL(page.url()).origin },
    data: { organizationId: firstId },
  });
  expect(switched.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('active-workspace-name')).toHaveText(firstName);
  await pingInChat(page);
  await expect(page.getByTestId('ping-workspace-id')).toHaveText(firstId);
  await expect(page.getByTestId('ping-workspace-role')).toHaveText('owner');
});
