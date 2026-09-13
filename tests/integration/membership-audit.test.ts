import type { LLMock } from '@copilotkit/aimock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthEmail } from '../../src/server/auth/mailer';
import { controlAuditLog } from '../../src/server/db/schema/control';
import { BASE_URL, prepareTestEnvironment, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;
type Person = { client: TestClient; email: string; userId: string; memberId: string };

let mock: LLMock;
let authRoute: { GET: Handler; POST: Handler };
let auth: typeof import('../../src/server/auth/auth').auth;
let controlDb: typeof import('../../src/server/db/client').controlDb;
let readOutbox: () => readonly AuthEmail[];

beforeAll(async () => {
  mock = await prepareTestEnvironment('membership-audit');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  ({ auth } = await import('../../src/server/auth/auth'));
  ({ controlDb } = await import('../../src/server/db/client'));
  ({ readMemoryOutbox: readOutbox } = await import('../../src/server/auth/mailer'));
});

afterAll(async () => {
  await mock?.stop();
});

const stamp = Date.now();
const person = (name: string): Person => ({
  client: new TestClient(),
  email: `${name}-${stamp}@example.test`,
  userId: '',
  memberId: '',
});
const [owner, invitee, viewer, decliner] = ['owner', 'invitee', 'viewer', 'decliner'].map(person);
let workspaceId = '';
let invitationId = '';

function post({ client }: Person, path: string, body: unknown) {
  return client.call(authRoute.POST, 'POST', `/api/auth${path}`, body);
}

async function signUp(someone: Person, { verified }: { verified: boolean }) {
  const credentials = { email: someone.email, password: 'integration-password-123' };
  const signedUp = await post(someone, '/sign-up/email', { ...credentials, name: 'Test' });
  expect(signedUp.status).toBe(200);
  someone.userId = ((await signedUp.json()) as { user: { id: string } }).user.id;
  expect((await post(someone, '/sign-in/email', credentials)).status).toBe(200);
  if (verified) await verify(someone);
}

/** Opens the emailed verification link with the recipient's cookies, as a browser would. */
async function verify(someone: Person) {
  const email = readOutbox().findLast((s) => s.kind === 'verify-email' && s.to === someone.email);
  if (!email) throw new Error(`no verification email to ${someone.email}`);
  const opened = await someone.client.call(authRoute.GET, 'GET', email.link.slice(BASE_URL.length));
  expect(opened.status).toBe(302);
}

async function invite(email: string, role: string) {
  const body = { email, role, organizationId: workspaceId };
  const invited = await post(owner, '/organization/invite-member', body);
  expect(invited.status).toBe(200);
  return ((await invited.json()) as { id: string }).id;
}

const seen = new Set<string>();

/** The control_audit_log rows appended since the previous call. */
async function newAuditRows() {
  const rows = await controlDb.select().from(controlAuditLog);
  const fresh = rows.filter((row) => !seen.has(row.id) && row.action !== 'workspace.provisioned');
  for (const row of fresh) seen.add(row.id);
  return fresh;
}

/** Asserts that exactly this one row was appended since the previous check. */
async function expectOneRow(
  actorUserId: string | null,
  action: string,
  targetType: 'invitation' | 'member',
  targetId: string,
  roles: { before?: string; after?: string },
) {
  expect(await newAuditRows()).toEqual([
    {
      id: expect.stringMatching(/^cad_[0-9A-HJKMNP-TV-Z]{26}$/),
      actorUserId,
      organizationId: workspaceId,
      action,
      targetType,
      targetId,
      beforeJson: roles.before ? JSON.stringify({ role: roles.before }) : null,
      afterJson: roles.after ? JSON.stringify({ role: roles.after }) : null,
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    },
  ]);
}

describe('AUTH-INT-005: membership changes append one control_audit_log row each', () => {
  it('records the creator of a workspace joining as owner', async () => {
    await signUp(owner, { verified: true });
    const body = { name: 'Audit Records', slug: `audit-records-${stamp}` };
    const created = await post(owner, '/organization/create', body);
    expect(created.status).toBe(200);
    const workspace = (await created.json()) as { id: string; members: { id: string }[] };
    workspaceId = workspace.id;
    owner.memberId = workspace.members[0]?.id ?? '';
    await expectOneRow(owner.userId, 'member.added', 'member', owner.memberId, { after: 'owner' });
  });

  it('records an invitation', async () => {
    invitationId = await invite(invitee.email, 'member');
    const roles = { after: 'member' };
    await expectOneRow(owner.userId, 'member.invited', 'invitation', invitationId, roles);
  });

  it('records nothing when an unverified invitee tries to accept', async () => {
    await signUp(invitee, { verified: false });
    const accepted = await post(invitee, '/organization/accept-invitation', { invitationId });
    expect(accepted.status).toBe(403);
    expect(await newAuditRows()).toEqual([]);
  });

  it('records an accepted invitation against the new member', async () => {
    await verify(invitee);
    const accepted = await post(invitee, '/organization/accept-invitation', { invitationId });
    expect(accepted.status).toBe(200);
    invitee.memberId = ((await accepted.json()) as { member: { id: string } }).member.id;
    const roles = { after: 'member' };
    await expectOneRow(invitee.userId, 'invitation.accepted', 'member', invitee.memberId, roles);
  });

  it('records a member added by a server call, which has no actor', async () => {
    await signUp(viewer, { verified: false });
    const body = { userId: viewer.userId, organizationId: workspaceId, role: 'viewer' as const };
    viewer.memberId = (await auth.api.addMember({ body })).id;
    await expectOneRow(null, 'member.added', 'member', viewer.memberId, { after: 'viewer' });
  });

  it('records nothing when a viewer tries to change a role', async () => {
    const body = { memberId: invitee.memberId, role: 'admin', organizationId: workspaceId };
    expect((await post(viewer, '/organization/update-member-role', body)).status).toBe(403);
    expect(await newAuditRows()).toEqual([]);
  });

  it('records a role change with the previous and the new role', async () => {
    const body = { memberId: invitee.memberId, role: 'admin', organizationId: workspaceId };
    expect((await post(owner, '/organization/update-member-role', body)).status).toBe(200);
    const roles = { before: 'member', after: 'admin' };
    await expectOneRow(owner.userId, 'member.role_changed', 'member', invitee.memberId, roles);
  });

  it('records a rejected invitation', async () => {
    const body = { invitationId: await invite(decliner.email, 'viewer') };
    expect(await newAuditRows()).toHaveLength(1);
    await signUp(decliner, { verified: true });
    expect((await post(decliner, '/organization/reject-invitation', body)).status).toBe(200);
    const roles = { before: 'viewer' };
    await expectOneRow(
      decliner.userId,
      'invitation.rejected',
      'invitation',
      body.invitationId,
      roles,
    );
  });

  it('records a canceled invitation, and nothing when a viewer tries to cancel it', async () => {
    const body = { invitationId: await invite(`canceled-${stamp}@example.test`, 'member') };
    expect(await newAuditRows()).toHaveLength(1);
    expect((await post(viewer, '/organization/cancel-invitation', body)).status).toBe(403);
    expect(await newAuditRows()).toEqual([]);

    expect((await post(owner, '/organization/cancel-invitation', body)).status).toBe(200);
    const roles = { before: 'member' };
    await expectOneRow(owner.userId, 'invitation.canceled', 'invitation', body.invitationId, roles);
  });

  it('records a removed member', async () => {
    const body = { memberIdOrEmail: viewer.memberId, organizationId: workspaceId };
    expect((await post(owner, '/organization/remove-member', body)).status).toBe(200);
    const roles = { before: 'viewer' };
    await expectOneRow(owner.userId, 'member.removed', 'member', viewer.memberId, roles);
  });

  it('records a member leaving, and nothing when the only owner tries to leave', async () => {
    const body = { organizationId: workspaceId };
    expect((await post(owner, '/organization/leave', body)).status).toBe(400);
    expect(await newAuditRows()).toEqual([]);

    expect((await post(invitee, '/organization/leave', body)).status).toBe(200);
    const roles = { before: 'admin' };
    await expectOneRow(invitee.userId, 'member.left', 'member', invitee.memberId, roles);
  });
});
