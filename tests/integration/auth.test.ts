import type { LLMock } from '@copilotkit/aimock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareTestEnvironment, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;

let mock: LLMock;
let authRoute: { GET: Handler; POST: Handler };
let auth: typeof import('../../src/server/auth/auth').auth;

beforeAll(async () => {
  mock = await prepareTestEnvironment('auth');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  ({ auth } = await import('../../src/server/auth/auth'));
});

afterAll(async () => {
  await mock?.stop();
});

async function signUpAndSignIn(client: TestClient, email: string) {
  const password = 'integration-password-123';
  const signUp = await client.call(authRoute.POST, 'POST', '/api/auth/sign-up/email', {
    email,
    password,
    name: email.split('@')[0],
  });
  expect(signUp.status).toBe(200);
  const { user } = (await signUp.json()) as { user: { id: string } };
  // autoSignIn is off: sign-up alone opens no session.
  expect(client.cookie).not.toContain('session_token');

  const signIn = await client.call(authRoute.POST, 'POST', '/api/auth/sign-in/email', {
    email,
    password,
  });
  expect(signIn.status).toBe(200);
  expect(client.cookie).toContain('session_token');
  return user.id;
}

describe('Better Auth: sign-up, sign-in, workspaces and roles', () => {
  const stamp = Date.now();
  const owner = new TestClient();
  const viewer = new TestClient();
  let workspaceId = '';

  it('signs up, then signs in', async () => {
    await signUpAndSignIn(owner, `owner-${stamp}@example.test`);
  });

  it('creates a workspace, sets it active, and makes the creator its owner', async () => {
    const created = await owner.call(authRoute.POST, 'POST', '/api/auth/organization/create', {
      name: 'Midnight Records',
      slug: `midnight-records-${stamp}`,
    });
    expect(created.status).toBe(200);
    workspaceId = ((await created.json()) as { id: string }).id;
    expect(workspaceId).toBeTruthy();

    const active = await owner.call(authRoute.POST, 'POST', '/api/auth/organization/set-active', {
      organizationId: workspaceId,
    });
    expect(active.status).toBe(200);

    const membership = await auth.api.getActiveMember({ headers: owner.headers() });
    expect(membership?.role).toBe('owner');
  });

  it('reads the session server-side with the active workspace', async () => {
    const session = await auth.api.getSession({ headers: owner.headers() });
    expect(session?.user.email).toBe(`owner-${stamp}@example.test`);
    expect(session?.session.activeOrganizationId).toBe(workspaceId);
  });

  it('gives the owner every workspace permission', async () => {
    const result = await auth.api.hasPermission({
      headers: owner.headers(),
      body: { permissions: { catalog: ['delete'], organization: ['delete'] } },
    });
    expect(result.success).toBe(true);
  });

  it('enforces the custom viewer role as read-only', async () => {
    const viewerId = await signUpAndSignIn(viewer, `viewer-${stamp}@example.test`);
    const added = await auth.api.addMember({
      body: { userId: viewerId, organizationId: workspaceId, role: 'viewer' },
    });
    expect(added?.role).toBe('viewer');

    const active = await viewer.call(authRoute.POST, 'POST', '/api/auth/organization/set-active', {
      organizationId: workspaceId,
    });
    expect(active.status).toBe(200);

    const canRead = await auth.api.hasPermission({
      headers: viewer.headers(),
      body: { permissions: { catalog: ['read'] } },
    });
    expect(canRead.success).toBe(true);

    const canCreate = await auth.api.hasPermission({
      headers: viewer.headers(),
      body: { permissions: { catalog: ['create'] } },
    });
    expect(canCreate.success).toBe(false);
  });
});
