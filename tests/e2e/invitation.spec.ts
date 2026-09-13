import { expect, test } from '@playwright/test';
import { AUTH_REDIRECT, readOutboxLink, signIn, signUp, signUpWithWorkspace } from './support';

// Prerequisite for AUTH-E2E-002. Links come from the development outbox (.data/auth-outbox/).
test('an invitee verifies their email, accepts the invitation and opens the workspace', async ({
  page,
  browser,
}) => {
  const workspaceName = await signUpWithWorkspace(page, 'Inviter');
  const inviteePage = await browser.newPage();
  const invitee = await signUp(inviteePage, 'Invitee');

  // No members UI yet (melos-9mg.5): the owner invites through the Better Auth endpoint.
  const invited = await page.request.post('/api/auth/organization/invite-member', {
    headers: { origin: new URL(page.url()).origin },
    data: { email: invitee.email, role: 'admin' },
  });
  expect(invited.ok()).toBe(true);

  await inviteePage.goto(readOutboxLink('verify-email', invitee.email));
  await expect(inviteePage).toHaveURL(/\/sign-in$/, AUTH_REDIRECT);
  await signIn(inviteePage, invitee);

  await inviteePage.goto(readOutboxLink('invitation', invitee.email));
  await expect(inviteePage.getByTestId('invitation-workspace-name')).toHaveText(workspaceName);
  await expect(inviteePage.getByTestId('invitation-role')).toHaveText('admin');
  await inviteePage.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(inviteePage.getByTestId('active-workspace-name')).toHaveText(
    workspaceName,
    AUTH_REDIRECT,
  );
  await inviteePage.close();
});
