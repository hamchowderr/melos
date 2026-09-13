import type { LLMock } from '@copilotkit/aimock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  statement,
  type WorkspacePermissions,
  type WorkspaceRole,
} from '../../src/lib/auth/permissions';
import { requirePermission } from '../../src/server/services/permissions';
import { PERMISSION_MATRIX, ROLES } from '../permission-matrix';
import { prepareTestEnvironment, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;

let mock: LLMock;
let authRoute: { POST: Handler };
let auth: typeof import('../../src/server/auth/auth').auth;
let workspaceId = '';
const clients = {} as Record<WorkspaceRole, TestClient>;
/** Each role as read back from its real member row, the way TenantContextResolver reads it. */
const memberRoles = {} as Record<WorkspaceRole, string>;

function post(client: TestClient, path: string, body: unknown) {
  return client.call(authRoute.POST, 'POST', `/api/auth${path}`, body);
}

function melosAllows(role: WorkspaceRole, permissions: WorkspacePermissions): boolean {
  return requirePermission({ workspaceRole: memberRoles[role] }, permissions).ok;
}

async function betterAuthAllows(role: WorkspaceRole, permissions: WorkspacePermissions) {
  const result = await auth.api.hasPermission({
    headers: clients[role].headers(),
    body: { permissions },
  });
  return result.success;
}

beforeAll(async () => {
  mock = await prepareTestEnvironment('permissions');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  ({ auth } = await import('../../src/server/auth/auth'));

  const stamp = Date.now();
  const password = 'integration-password-123';
  for (const role of ROLES) {
    const client = new TestClient();
    const email = `${role}-${stamp}@example.test`;
    const signUp = await post(client, '/sign-up/email', { email, password, name: role });
    expect(signUp.status).toBe(200);
    const { user } = (await signUp.json()) as { user: { id: string } };
    expect((await post(client, '/sign-in/email', { email, password })).status).toBe(200);

    if (role === 'owner') {
      const created = await post(client, '/organization/create', {
        name: 'Permission Records',
        slug: `permission-records-${stamp}`,
      });
      workspaceId = ((await created.json()) as { id: string }).id;
    } else {
      await auth.api.addMember({ body: { userId: user.id, organizationId: workspaceId, role } });
    }
    const active = await post(client, '/organization/set-active', { organizationId: workspaceId });
    expect(active.status).toBe(200);

    clients[role] = client;
    const membership = await auth.api.getActiveMember({ headers: client.headers() });
    memberRoles[role] = membership?.role ?? '';
    expect(memberRoles[role]).toBe(role);
  }
});

afterAll(async () => {
  await mock?.stop();
});

describe('AUTH-INT-004: the §6.2 matrix at the service boundary', () => {
  for (const row of PERMISSION_MATRIX) {
    it(`${row.operation} (${JSON.stringify(row.permissions)})`, async () => {
      for (const role of ROLES) {
        const expected = row.allowed.includes(role);
        expect(melosAllows(role, row.permissions), `${role}: requirePermission`).toBe(expected);
        expect(await betterAuthAllows(role, row.permissions), `${role}: hasPermission`).toBe(
          expected,
        );
      }
    });
  }
});

describe('AUTH-INT-007: the viewer is read-only', () => {
  const viewerReads = ['catalog', 'rights', 'contact', 'pitch', 'report'];

  it('refuses every statement action except the five reads, in Melos and Better Auth', async () => {
    for (const [resource, actions] of Object.entries(statement)) {
      for (const action of actions) {
        const permissions = { [resource]: [action] } as WorkspacePermissions;
        const expected = action === 'read' && viewerReads.includes(resource);
        const label = `${resource}:${action}`;
        expect(melosAllows('viewer', permissions), label).toBe(expected);
        expect(await betterAuthAllows('viewer', permissions), label).toBe(expected);
      }
    }
  });

  it('refuses a viewer write at the server when the UI is bypassed', async () => {
    const invite = await post(clients.viewer, '/organization/invite-member', {
      email: `bypass-${Date.now()}@example.test`,
      role: 'member',
      organizationId: workspaceId,
    });
    expect(invite.status).toBe(403);

    expect(
      requirePermission({ workspaceRole: memberRoles.viewer }, { catalog: ['create'] }),
    ).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: expect.any(String) } });
  });

  it('refuses a member invitation at the server, while the owner may invite', async () => {
    const email = `invitee-${Date.now()}@example.test`;
    const body = { email, role: 'member', organizationId: workspaceId };
    expect((await post(clients.member, '/organization/invite-member', body)).status).toBe(403);
    expect((await post(clients.owner, '/organization/invite-member', body)).status).toBe(200);
  });
});
