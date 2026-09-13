import type { LLMock } from '@copilotkit/aimock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspacePermissions, WorkspaceRole } from '../../src/lib/auth/permissions';
import { requirePermission } from '../../src/server/services/permissions';
import { ROLES } from '../permission-matrix';
import { prepareTestEnvironment, TestClient } from './support';

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
let authRoute: { POST: Handler };
let auth: typeof import('../../src/server/auth/auth').auth;
let workspaceId = '';
const clients = {} as Record<WorkspaceRole, TestClient>;
const memberIds = {} as Record<WorkspaceRole, string>;

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

beforeAll(async () => {
  mock = await prepareTestEnvironment('members');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  ({ auth } = await import('../../src/server/auth/auth'));

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
});
