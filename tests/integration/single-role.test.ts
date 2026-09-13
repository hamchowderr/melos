import type { LLMock } from '@copilotkit/aimock';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '../../src/lib/auth/permissions';
import { invitation } from '../../src/server/db/schema/auth';
import { controlAuditLog } from '../../src/server/db/schema/control';
import { prepareTestEnvironment, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;

/** Better Auth 1.7.4 alone would store these as `owner,viewer`, `owner,viewer` and `viewer`. */
const BAD_ROLES = [['owner', 'viewer'], 'owner,viewer', ['viewer']];
const refused = { status: 400, body: { code: 'INVALID_ROLE' } };
const stamp = Date.now();
const password = 'integration-password-123';
const owner = new TestClient();
const pendingEmail = `pending-${stamp}@example.test`;
let mock: LLMock;
let authRoute: { POST: Handler };
let auth: typeof import('../../src/server/auth/auth').auth;
let controlDb: typeof import('../../src/server/db/client').controlDb;
let memberId = '';

async function post(path: string, body: object) {
  const response = await owner.call(authRoute.POST, 'POST', `/api/auth${path}`, body);
  return { status: response.status, body: (await response.json()) as { code?: string } };
}

async function storedRole() {
  const { members } = await auth.api.listMembers({ headers: owner.headers() });
  return members.find((member) => member.id === memberId)?.role;
}

const invitationsTo = (email: string) =>
  controlDb.select().from(invitation).where(eq(invitation.email, email));
const auditRowCount = async () => (await controlDb.select().from(controlAuditLog)).length;

beforeAll(async () => {
  mock = await prepareTestEnvironment('single-role');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  ({ auth } = await import('../../src/server/auth/auth'));
  ({ controlDb } = await import('../../src/server/db/client'));

  const email = `owner-${stamp}@example.test`;
  await auth.api.signUpEmail({ body: { email, password, name: 'Owner' } });
  expect((await post('/sign-in/email', { email, password })).status).toBe(200);
  const workspace = { name: 'Role Records', slug: `role-records-${stamp}` };
  const { id: organizationId } = await auth.api.createOrganization({
    headers: owner.headers(),
    body: workspace,
  });
  expect((await post('/organization/set-active', { organizationId })).status).toBe(200);

  const target = { email: `target-${stamp}@example.test`, password, name: 'Target' };
  const { user } = await auth.api.signUpEmail({ body: target });
  const body = { userId: user.id, organizationId, role: 'viewer' as const };
  memberId = (await auth.api.addMember({ body })).id;
  expect(
    (await post('/organization/invite-member', { email: pendingEmail, role: 'member' })).status,
  ).toBe(200);
});

afterAll(async () => {
  await mock?.stop();
});

describe('P-30: a member role or invitation holds exactly one role', () => {
  it('refuses an array or comma-separated role change, over HTTP and auth.api, and keeps the stored role', async () => {
    const audited = await auditRowCount();
    for (const role of BAD_ROLES) {
      expect(
        await post('/organization/update-member-role', { memberId, role }),
        String(role),
      ).toMatchObject(refused);
      const serverCall = auth.api.updateMemberRole({
        headers: owner.headers(),
        body: { memberId, role },
      });
      await expect(serverCall, String(role)).rejects.toMatchObject({
        statusCode: 400,
        body: refused.body,
      });
      expect(await storedRole(), String(role)).toBe('viewer');
    }
    expect(await auditRowCount()).toBe(audited);
  });

  it('refuses an array or comma-separated invitation, over HTTP and auth.api, and creates no invitation', async () => {
    const audited = await auditRowCount();
    for (const [index, role] of BAD_ROLES.entries()) {
      const email = `refused-${index}-${stamp}@example.test`;
      expect(
        await post('/organization/invite-member', { email, role }),
        String(role),
      ).toMatchObject(refused);
      // The typed API forbids a comma-separated role; an untyped server caller can still send one.
      const serverCall = auth.api.createInvitation({
        headers: owner.headers(),
        body: { email, role: role as WorkspaceRole },
      });
      await expect(serverCall, String(role)).rejects.toMatchObject({
        statusCode: 400,
        body: refused.body,
      });
      expect(await invitationsTo(email), String(role)).toEqual([]);
    }
    expect(await auditRowCount()).toBe(audited);
  });

  it('refuses a resend with a bad role and leaves the pending invitation unchanged', async () => {
    const audited = await auditRowCount();
    const before = await invitationsTo(pendingEmail);
    expect(before).toMatchObject([{ role: 'member', status: 'pending' }]);
    for (const role of BAD_ROLES) {
      const resend = { email: pendingEmail, role, resend: true };
      expect(await post('/organization/invite-member', resend), String(role)).toMatchObject(
        refused,
      );
    }
    expect(await invitationsTo(pendingEmail)).toEqual(before);
    expect(await auditRowCount()).toBe(audited);

    // The same resend with one role is accepted.
    const resend = { email: pendingEmail, role: 'member', resend: true };
    expect((await post('/organization/invite-member', resend)).status).toBe(200);
  });

  it('still accepts a single role for a role change and an invitation', async () => {
    const audited = await auditRowCount();
    expect(
      (await post('/organization/update-member-role', { memberId, role: 'member' })).status,
    ).toBe(200);
    expect(await storedRole()).toBe('member');

    const email = `accepted-${stamp}@example.test`;
    expect((await post('/organization/invite-member', { email, role: 'viewer' })).status).toBe(200);
    expect(await invitationsTo(email)).toMatchObject([{ role: 'viewer', status: 'pending' }]);
    // member.role_changed and member.invited.
    expect(await auditRowCount()).toBe(audited + 2);
  });
});
