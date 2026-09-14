import { expect, type Page, test } from '@playwright/test';
import {
  AUTH_REDIRECT,
  activeOrganizationId,
  activeWorkspaceId,
  createWorkspace,
  pingInChat,
  setMemberRole,
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

  // Switches through the endpoint the auth client calls, on purpose: this test is about tool
  // results following the switch; the melos-g4u tests drive the workspace list.
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

  // A new session starts with no active workspace, whichever was active before; the ping below
  // proves the pick opened North.
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

/** Signs up a user who owns two workspaces, named with `labels`; the second is active. */
async function signUpWithTwoWorkspaces(page: Page, user: string, labels: [string, string]) {
  await signIn(page, await signUp(page, user));
  const names = labels.map((label) => `${user} ${label} ${Date.now()}`);
  await createWorkspace(page, names[0]);
  const firstId = await activeOrganizationId(page);
  await page.goto('/workspaces/new');
  await createWorkspace(page, names[1]);
  return { names, firstId, secondId: await activeOrganizationId(page) };
}

const workspaceButtons = (page: Page) =>
  page.getByRole('list', { name: 'Your workspaces' }).getByRole('button');

test('melos-g4u: a signed-in user signs out from the workspace header', async ({ page }) => {
  await signUpWithWorkspace(page, 'Leave');
  await page.goto('/settings');
  await expect(page.getByRole('link', { name: 'Switch workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/, AUTH_REDIRECT);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('melos-g4u: a member of two workspaces switches from the workspace header', async ({
  page,
}) => {
  const { names, firstId } = await signUpWithTwoWorkspaces(page, 'Header', ['North', 'South']);
  await page.getByRole('link', { name: 'Switch workspace' }).click();
  await expect(page).toHaveURL(/\/workspaces$/);

  // Holds set-active so the chosen button's pending text can be seen.
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  await page.route('**/api/auth/organization/set-active', async (route) => {
    await held;
    await route.continue();
  });
  const [north, south] = names.map((name) => workspaceButtons(page).filter({ hasText: name }));
  await north.click();
  await expect(north).toContainText('Opening...');
  await expect(north).toBeDisabled();
  await expect(south).toBeDisabled();
  release();

  await expect(page).toHaveURL(`${new URL(page.url()).origin}/`, AUTH_REDIRECT);
  await expect(page.getByTestId('active-workspace-name')).toHaveText(names[0]);
  await expectPing(page, firstId);
});

test('melos-g4u: a member stuck on a failed workspace switches or signs out from its screen', async ({
  page,
}) => {
  const { names, firstId, secondId } = await signUpWithTwoWorkspaces(page, 'Stuck', [
    'Healthy',
    'Failed',
  ]);
  await setWorkspaceStatus(secondId, 'failed');
  const home = `${new URL(page.url()).origin}/`;
  const notReady = page.getByTestId('workspace-not-ready');

  await page.reload();
  await expect(notReady).toHaveAttribute('data-status', 'failed');
  await page.getByRole('link', { name: 'Switch workspace' }).click();
  await workspaceButtons(page).filter({ hasText: names[0] }).click();
  await expect(page).toHaveURL(home, AUTH_REDIRECT);
  await expect(page.getByTestId('active-workspace-name')).toHaveText(names[0]);
  await expectPing(page, firstId);

  await page.getByRole('link', { name: 'Switch workspace' }).click();
  await workspaceButtons(page).filter({ hasText: names[1] }).click();
  await expect(notReady).toHaveAttribute('data-status', 'failed', AUTH_REDIRECT);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/, AUTH_REDIRECT);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('melos-g4u: a member whose active workspace has an invalid role picks from the others', async ({
  page,
}) => {
  const { names, secondId } = await signUpWithTwoWorkspaces(page, 'Misrole', ['Kept', 'Broken']);
  // A configuration error: Melos assigns one role per member (P-30).
  await setMemberRole(secondId, 'owner,viewer');

  for (const path of ['/', '/settings']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/workspaces$/);
    await expect(workspaceButtons(page)).toHaveCount(1);
    await expect(workspaceButtons(page)).toContainText(names[0]);
  }
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

test('TEN-002: a member of a provisioning workspace is not told a reload opens chat', async ({
  page,
}) => {
  await signUpWithWorkspace(page, 'Provisioning');
  await setWorkspaceStatus(await activeOrganizationId(page), 'provisioning');

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Your workspace is still being set up' }),
  ).toBeVisible();
  // An attempt that dies before its last write leaves the row provisioning until a retry (ADR-032).
  const message = page.getByTestId('workspace-not-ready');
  await expect(message).toHaveAttribute('data-status', 'provisioning');
  await expect(message).toHaveText(
    'Chat opens once its database is ready. If it stays unavailable, try again later, or contact the workspace owner.',
  );
  await expect(page.getByRole('textbox')).toHaveCount(0);
});
