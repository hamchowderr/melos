import type { LLMock } from '@copilotkit/aimock';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspacePermissions, WorkspaceRole } from '../../src/lib/auth/permissions';
import type { AuthEmail } from '../../src/server/auth/mailer';
import { controlAuditLog } from '../../src/server/db/schema/control';
import { requirePermission } from '../../src/server/services/permissions';
import { ROLES } from '../permission-matrix';
import { BASE_URL, prepareTestEnvironment, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;

/** What /settings checks to show its invite, role and remove controls. */
const CONTROLS: WorkspacePermissions[] = [
  { invitation: ['create'] },
  { member: ['update'] },
  { member: ['delete'] },
];
const stamp = Date.now();
const password = 'integration-password-123';
let mock: LLMock;
let authRoute: { GET: Handler; POST: Handler };
let auth: typeof import('../../src/server/auth/auth').auth;
let controlDb: typeof import('../../src/server/db/client').controlDb;
let readOutbox: () => readonly AuthEmail[];
let workspaceId = '';
const clients = {} as Record<WorkspaceRole, TestClient>;
const memberIds = {} as Record<WorkspaceRole, string>;
const userIds = {} as Record<WorkspaceRole, string>;

async function post(client: TestClient, path: string, body: object) {
  const response = await client.call(authRoute.POST, 'POST', `/api/auth${path}`, body);
  return { status: response.status, body: (await response.json()) as { id?: string } };
}

async function addMember(userId: string, role: WorkspaceRole): Promise<string> {
  const added = await auth.api.addMember({ body: { userId, organizationId: workspaceId, role } });
  return added.id;
}

async function storedRole(memberId: string) {
  const { members } = await auth.api.listMembers({ headers: clients.owner.headers() });
  return members.find((member) => member.id === memberId)?.role;
}

/** The workspace's pending invitations, as /settings reads them. */
async function pendingInvitations() {
  const query = { organizationId: workspaceId };
  const all = await auth.api.listInvitations({ headers: clients.owner.headers(), query });
  return all.filter((invitation) => invitation.status === 'pending');
}

beforeAll(async () => {
  mock = await prepareTestEnvironment('members');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  ({ auth } = await import('../../src/server/auth/auth'));
  ({ controlDb } = await import('../../src/server/db/client'));
  ({ readMemoryOutbox: readOutbox } = await import('../../src/server/auth/mailer'));

  for (const role of ROLES) {
    const email = `${role}-${stamp}@example.test`;
    const { user } = await auth.api.signUpEmail({ body: { email, password, name: role } });
    const client = new TestClient();
    expect((await post(client, '/sign-in/email', { email, password })).status).toBe(200);
    if (role === 'owner') {
      const workspace = { name: 'Member Records', slug: `member-records-${stamp}` };
      workspaceId = String((await post(client, '/organization/create', workspace)).body.id);
    } else {
      await addMember(user.id, role);
    }
    await post(client, '/organization/set-active', { organizationId: workspaceId });
    clients[role] = client;
    userIds[role] = user.id;
    memberIds[role] = String((await auth.api.getActiveMember({ headers: client.headers() }))?.id);
  }
});

afterAll(async () => {
  await mock?.stop();
});

describe('AUTH-002: the server enforces member management from /settings (AUTH-004)', () => {
  it('lets owners and admins invite, change a role and remove; refuses members and viewers', async () => {
    for (const role of ROLES) {
      const allowed = role === 'owner' || role === 'admin';
      const email = `target-${role}-${stamp}@example.test`;
      const { user } = await auth.api.signUpEmail({ body: { email, password, name: 'Target' } });
      const memberId = await addMember(user.id, 'viewer');
      const client = clients[role];

      const invited = { email: `invited-${email}`, role: 'viewer' };
      const invite = await post(client, '/organization/invite-member', invited);
      const toMember = { memberId, role: 'member' };
      const update = await post(client, '/organization/update-member-role', toMember);
      const roleAfterUpdate = await storedRole(memberId);
      const removal = { memberIdOrEmail: memberId };
      const remove = await post(client, '/organization/remove-member', removal);

      // Better Auth 1.7.4 refuses a removal with 401 and an invitation or role change with 403.
      const statuses = [invite.status, update.status, remove.status];
      expect(statuses, role).toEqual(allowed ? [200, 200, 200] : [403, 403, 401]);
      expect(roleAfterUpdate, role).toBe(allowed ? 'member' : 'viewer');
      expect(await storedRole(memberId), role).toBe(allowed ? undefined : 'viewer');
      // The page shows or hides the same controls through requirePermission.
      const shown = CONTROLS.map((check) => requirePermission({ workspaceRole: role }, check).ok);
      expect(shown, role).toEqual([allowed, allowed, allowed]);
    }
  });

  it('refuses to demote or remove the last owner', async () => {
    const memberId = memberIds.owner;
    const demote = { memberId, role: 'admin' };
    const removal = { memberIdOrEmail: memberId };
    expect(await post(clients.owner, '/organization/update-member-role', demote)).toMatchObject({
      status: 400,
      body: { code: 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER' },
    });
    expect(await post(clients.owner, '/organization/remove-member', removal)).toMatchObject({
      status: 400,
      body: { code: 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER' },
    });

    // An admin manages members but can neither demote nor remove an owner.
    const demoteByAdmin = await post(clients.admin, '/organization/update-member-role', demote);
    const removeByAdmin = await post(clients.admin, '/organization/remove-member', removal);
    expect([demoteByAdmin.status, removeByAdmin.status]).toEqual([403, 400]);
    expect(await storedRole(memberId)).toBe('owner');
  });

  it('lists a pending invitation that an owner cancels and members and viewers cannot', async () => {
    // A verified invitee, so only the cancellation can stop them from accepting.
    const email = `pending-${stamp}@example.test`;
    const invitee = new TestClient();
    expect(
      (await post(invitee, '/sign-up/email', { email, password, name: 'Invitee' })).status,
    ).toBe(200);
    expect((await post(invitee, '/sign-in/email', { email, password })).status).toBe(200);
    const verification = readOutbox().findLast((s) => s.kind === 'verify-email' && s.to === email);
    const verifyPath = String(verification?.link).slice(BASE_URL.length);
    expect((await invitee.call(authRoute.GET, 'GET', verifyPath)).status).toBe(302);

    const invite = await post(clients.owner, '/organization/invite-member', {
      email,
      role: 'member',
    });
    const invitationId = String(invite.body.id);
    const listed = { id: invitationId, email, role: 'member', inviterId: userIds.owner };
    expect(await pendingInvitations()).toContainEqual(expect.objectContaining(listed));

    // Better Auth 1.7.4 checks invitation:cancel and refuses with 403.
    for (const role of ['member', 'viewer'] as const) {
      const refused = await post(clients[role], '/organization/cancel-invitation', {
        invitationId,
      });
      expect(refused.status, role).toBe(403);
    }
    expect(await pendingInvitations()).toContainEqual(expect.objectContaining(listed));

    const canceled = await post(clients.owner, '/organization/cancel-invitation', { invitationId });
    expect(canceled.status).toBe(200);
    expect((await pendingInvitations()).map(({ id }) => id)).not.toContain(invitationId);

    // The emailed link no longer opens the invitation (/invitations/[id]) or accepts it.
    const query = { id: invitationId };
    const opened = auth.api.getInvitation({ headers: invitee.headers(), query });
    await expect(opened).rejects.toThrow('Invitation not found!');
    expect(await post(invitee, '/organization/accept-invitation', { invitationId })).toMatchObject({
      status: 400,
      body: { code: 'INVITATION_NOT_FOUND' },
    });

    // One audit row, from the owner's cancellation; the refused attempts wrote none (ADR-029).
    const byAction = and(
      eq(controlAuditLog.targetId, invitationId),
      eq(controlAuditLog.action, 'invitation.canceled'),
    );
    expect(await controlDb.select().from(controlAuditLog).where(byAction)).toMatchObject([
      {
        actorUserId: userIds.owner,
        organizationId: workspaceId,
        targetType: 'invitation',
        beforeJson: JSON.stringify({ role: 'member' }),
      },
    ]);
  });
});
