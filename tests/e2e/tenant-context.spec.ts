import { expect, type Page, test } from '@playwright/test';
import {
  AUTH_REDIRECT,
  activeOrganizationId,
  activeWorkspaceId,
  createWorkspace,
  pingInChat,
  setWorkspaceStatus,
  signIn,
  signOut,
  signUp,
  signUpWithWorkspace,
} from './support';

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

/** The ping card names the organization, its registry workspace id and the role. */
async function expectPing(page: Page, organizationId: string): Promise<void> {
  await pingInChat(page);
  await expect(page.getByTestId('ping-organization-id')).toHaveText(organizationId);
  const workspaceId = await activeWorkspaceId(organizationId);
  await expect(page.getByTestId('ping-workspace-id')).toHaveText(workspaceId);
  await expect(page.getByTestId('ping-workspace-role')).toHaveText('owner');
}

test('AUTH-E2E-003: tool results follow the newly active workspace', async ({ page }) => {
  const firstName = await signUpWithWorkspace(page, 'Switch');
  const firstId = await activeOrganizationId(page);

  const secondName = `${firstName} Two`;
  await page.goto('/workspaces/new');
  await createWorkspace(page, secondName);
  const secondId = await activeOrganizationId(page);
  expect(secondId).not.toBe(firstId);
  expect(await activeWorkspaceId(secondId)).not.toBe(await activeWorkspaceId(firstId));
  await expectPing(page, secondId);

  // No workspace switcher exists yet; switch through the endpoint the auth client calls.
  // Better Auth refuses a cookie-bearing POST without an Origin header.
  const switched = await page.request.post('/api/auth/organization/set-active', {
    headers: { origin: new URL(page.url()).origin },
    data: { organizationId: firstId },
  });
  expect(switched.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('active-workspace-name')).toHaveText(firstName);
  await expectPing(page, firstId);
});

test('melos-2lm: a member of one workspace signs back in to its chat, not /workspaces/new', async ({
  page,
}) => {
  const user = await signUp(page, 'Return');
  await signIn(page, user);
  const workspaceName = `Return Records ${Date.now()}`;
  await createWorkspace(page, workspaceName);
  const organizationId = await activeOrganizationId(page);

  await signOut(page);
  await page.goto('/sign-in');
  await signIn(page, user, `${new URL(page.url()).origin}/`);
  await expect(page.getByTestId('active-workspace-name')).toHaveText(workspaceName);
  await expectPing(page, organizationId);
});

test('melos-2lm: a member of two workspaces picks one after signing in and reaches its chat', async ({
  page,
}) => {
  const user = await signUp(page, 'Picker');
  await signIn(page, user);
  const [north, south] = ['North', 'South'].map((name) => `Picker ${name} ${Date.now()}`);
  await createWorkspace(page, north);
  const northId = await activeOrganizationId(page);
  await page.goto('/workspaces/new');
  await createWorkspace(page, south);

  await signOut(page);
  await page.goto('/sign-in');
  await signIn(page, user, /\/workspaces$/);
  const workspaces = page.getByRole('list', { name: 'Your workspaces' }).getByRole('button');
  await expect(workspaces).toContainText([north, south]);
  await expect(workspaces.getByText('owner', { exact: true })).toHaveCount(2);

  // South was active at sign-out; picking North proves the pick sets the workspace.
  await workspaces.filter({ hasText: north }).click();
  await expect(page).toHaveURL(`${new URL(page.url()).origin}/`, AUTH_REDIRECT);
  await expect(page.getByTestId('active-workspace-name')).toHaveText(north);
  await expectPing(page, northId);
});

test('melos-2lm: a user with no workspace is still sent to /workspaces/new', async ({ page }) => {
  // signIn waits for /workspaces/new; the workspace list sends the user there too.
  await signIn(page, await signUp(page, 'Empty'));
  await page.goto('/workspaces');
  await expect(page).toHaveURL(/\/workspaces\/new$/);
  await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
});

test('TEN-002: a member of a failed workspace is told why, not sent to /workspaces/new', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Failed');
  await setWorkspaceStatus(await activeOrganizationId(page), 'failed');
  const home = `${new URL(page.url()).origin}/`;

  for (const path of ['/', '/settings']) {
    await page.goto(path);
    await expect(page).toHaveURL(home);
    await expect(
      page.getByRole('heading', { name: 'Your workspace is not available right now' }),
    ).toBeVisible();
    await expect(page.getByTestId('workspace-not-ready')).toHaveAttribute('data-status', 'failed');
    await expect(page.getByRole('textbox')).toHaveCount(0);
  }
  const info = await page.request.get('/api/copilotkit/info');
  expect([info.status(), await info.json()]).toEqual([403, { error: 'workspace-unavailable' }]);
});

test('TEN-002: a member of a migrating workspace is not told a reload opens chat', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Migrating');
  await setWorkspaceStatus(await activeOrganizationId(page), 'migrating');

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Your workspace is being updated' }),
  ).toBeVisible();
  // A locked final registry write leaves the row migrating until a rerun takes it over (ADR-033).
  const message = page.getByTestId('workspace-not-ready');
  await expect(message).toHaveAttribute('data-status', 'migrating');
  await expect(message).toHaveText(
    'Chat opens again once the update finishes. If it stays unavailable, try again later, or contact the workspace owner.',
  );
  await expect(page.getByRole('textbox')).toHaveCount(0);
});
