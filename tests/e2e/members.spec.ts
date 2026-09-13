import { expect, type Page, test } from '@playwright/test';
import {
  AUTH_REDIRECT,
  pingInChat,
  readOutboxLink,
  signIn,
  signUp,
  signUpWithWorkspace,
} from './support';

/** The workspace role the agent resolves for this user's next request. */
async function expectAgentRole(page: Page, role: string): Promise<void> {
  await page.reload();
  await pingInChat(page);
  await expect(page.getByTestId('ping-workspace-role')).toHaveText(role);
}

/** Hidden controls are not authorization: calling the endpoints directly is refused. */
async function expectDirectCallsRefused(page: Page): Promise<void> {
  const headers = { origin: new URL(page.url()).origin };
  const self = await (await page.request.get('/api/auth/organization/get-active-member')).json();
  const invite = await page.request.post('/api/auth/organization/invite-member', {
    headers,
    data: { email: `bypass-${Date.now()}@example.test`, role: 'viewer' },
  });
  const promote = await page.request.post('/api/auth/organization/update-member-role', {
    headers,
    data: { memberId: self.id, role: 'admin' },
  });
  expect([invite.status(), promote.status()]).toEqual([403, 403]);
}

// Links come from the development outbox (.data/auth-outbox/); the model is AIMock.
test('AUTH-E2E-002: an owner invites a member, changes their role and removes them', async ({
  page,
  browser,
}) => {
  test.slow();
  const workspaceName = await signUpWithWorkspace(page, 'Owner');
  const inviteePage = await browser.newPage();
  const invitee = await signUp(inviteePage, 'Teammate');

  await page.getByRole('link', { name: 'Settings' }).click();
  const inviteForm = page.locator('form');
  await inviteForm.getByLabel('Email').fill(invitee.email);
  await inviteForm.getByLabel('Role').selectOption('viewer');
  await inviteForm.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toHaveText(`Invitation sent to ${invitee.email}.`);

  await inviteePage.goto(readOutboxLink('verify-email', invitee.email));
  await expect(inviteePage).toHaveURL(/\/sign-in$/, AUTH_REDIRECT);
  await signIn(inviteePage, invitee);
  await inviteePage.goto(readOutboxLink('invitation', invitee.email));
  await inviteePage.getByRole('button', { name: 'Accept invitation' }).click();
  const inviteeWorkspace = inviteePage.getByTestId('active-workspace-name');
  await expect(inviteeWorkspace).toHaveText(workspaceName, AUTH_REDIRECT);

  const role = page.getByLabel(`Role for ${invitee.email}`);
  await page.reload();
  await expect(role).toHaveValue('viewer');
  await expectAgentRole(inviteePage, 'viewer');
  await expectDirectCallsRefused(inviteePage);

  await role.selectOption('member');
  await expect(page.getByRole('status')).toHaveText(`${invitee.email} is now member.`);
  await expect(role).toHaveValue('member');
  await expectAgentRole(inviteePage, 'member');
  await expectDirectCallsRefused(inviteePage);

  await page.getByRole('button', { name: `Remove ${invitee.email}` }).click();
  await expect(role).toHaveCount(0);
  expect((await inviteePage.request.get('/api/copilotkit/info')).status()).toBe(403);
  await inviteePage.close();
});
