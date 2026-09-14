import type { LLMock } from '@copilotkit/aimock';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { member, session } from '../../src/server/db/schema/auth';
import { workspaceRegistry } from '../../src/server/db/schema/control';
import { prepareTestEnvironment, readAgUiEvents, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;
type AuthBody = { id: string; user: { id: string } };
type SignedIn = Awaited<ReturnType<typeof signIn>>;

const RUN_PATH = '/api/copilotkit/agent/melos/run';
const stamp = Date.now();
let mock: LLMock;
let authRoute: { POST: Handler };
let copilotRoute: { POST: Handler };
let auth: typeof import('../../src/server/auth/auth').auth;
let controlDb: typeof import('../../src/server/db/client').controlDb;
let resolver: typeof import('../../src/server/services/tenant-context').tenantContextResolver;

beforeAll(async () => {
  mock = await prepareTestEnvironment('tenant');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  copilotRoute = await import('../../src/app/api/copilotkit/[[...slug]]/route');
  ({ auth } = await import('../../src/server/auth/auth'));
  ({ controlDb } = await import('../../src/server/db/client'));
  ({ tenantContextResolver: resolver } = await import('../../src/server/services/tenant-context'));
});

afterAll(async () => {
  await mock?.stop();
});

async function post(client: TestClient, path: string, body: object): Promise<AuthBody> {
  const response = await client.call(authRoute.POST, 'POST', `/api/auth${path}`, body);
  expect(response.status, path).toBe(200);
  return (await response.json()) as AuthBody;
}

async function signIn(label: string) {
  const client = new TestClient();
  const email = `${label}-${stamp}@example.test`;
  const password = 'integration-password-123';
  const { user } = await post(client, '/sign-up/email', { email, password, name: label });
  await post(client, '/sign-in/email', { email, password });
  return { client, email, userId: user.id };
}

/** Registry workspace id by organization id, recorded as each workspace is created. */
const workspaceIds = new Map<string, string>();

/** Creates a workspace owned by the client and makes it active; returns the organization id. */
async function createWorkspace(client: TestClient, name: string): Promise<string> {
  const { id } = await post(client, '/organization/create', { name, slug: `${name}-${stamp}` });
  await post(client, '/organization/set-active', { organizationId: id });
  const columns = { id: workspaceRegistry.id, status: workspaceRegistry.status };
  const byOrganization = eq(workspaceRegistry.organizationId, id);
  const rows = await controlDb.select(columns).from(workspaceRegistry).where(byOrganization);
  expect(rows).toEqual([{ id: expect.stringMatching(/^ws_/), status: 'active' }]);
  workspaceIds.set(id, rows[0].id);
  return id;
}

let runs = 0;
/** An AG-UI run answered by fixtures/aimock/ping.json; `spoof` goes in context, props and headers. */
function run(client: TestClient, spoof: Record<string, string> = {}) {
  runs += 1;
  const id = `tenant-${stamp}-${runs}`;
  const context = Object.entries(spoof).map(([description, value]) => ({ description, value }));
  client.extraHeaders = Object.fromEntries(context.map((c) => [`x-${c.description}`, c.value]));
  const input = { threadId: id, runId: id, tools: [], context, state: {}, forwardedProps: spoof };
  const messages = [{ id, role: 'user', content: 'ping' }];
  return client.call(copilotRoute.POST, 'POST', RUN_PATH, { ...input, messages });
}

async function pingResult(client: TestClient, spoof?: Record<string, string>) {
  const response = await run(client, spoof);
  expect(response.status).toBe(200);
  const events = await readAgUiEvents(response);
  return JSON.parse(events.find((event) => event.type === 'TOOL_CALL_RESULT')?.content ?? '{}');
}

/** The route refuses the run before any model call. */
async function expectRefused(client: TestClient, status: number, error: string) {
  const modelCalls = mock.getRequests().length;
  const response = await run(client);
  expect([response.status, await response.json()]).toEqual([status, { error }]);
  expect(mock.getRequests().length).toBe(modelCalls);
}

describe('AUTH-INT-008: tenant context from the session, the member row and the registry', () => {
  let user: SignedIn;
  let other: SignedIn;
  let alpha = '';
  let beta = '';
  const tenant = (organizationId: string, workspaceRole: string) => ({
    userId: user.userId,
    organizationId,
    workspaceId: workspaceIds.get(organizationId),
    workspaceRole,
  });

  it('answers 401 without a valid session and 403 without an active workspace', async () => {
    await expectRefused(new TestClient(), 401, 'unauthenticated');
    const forged = new TestClient();
    forged.cookie = 'better-auth.session_token=forged-token.forged-signature';
    await expectRefused(forged, 401, 'unauthenticated');

    const expiring = await signIn('expiring');
    await expectRefused(expiring.client, 403, 'no-active-workspace');
    const expiresAt = new Date(Date.now() - 60_000);
    await controlDb.update(session).set({ expiresAt }).where(eq(session.userId, expiring.userId));
    await expectRefused(expiring.client, 401, 'unauthenticated');
  });

  it('resolves userId, organizationId, workspaceId, workspaceRole and requestId (TEN-002)', async () => {
    user = await signIn('tenant');
    alpha = await createWorkspace(user.client, 'alpha');
    const context = { ...tenant(alpha, 'owner'), requestId: expect.any(String) };
    expect(await resolver.resolve(user.client.headers())).toEqual({ status: 'ok', context });
  });

  it('gives the newly active workspace, its registry id and its role on the next request', async () => {
    other = await signIn('other');
    beta = await createWorkspace(other.client, 'beta');
    const body = { userId: user.userId, organizationId: beta, role: 'viewer' as const };
    await auth.api.addMember({ body });

    expect(await pingResult(user.client)).toEqual({ status: 'ok', ...tenant(alpha, 'owner') });
    await post(user.client, '/organization/set-active', { organizationId: beta });
    expect(await pingResult(user.client)).toEqual({ status: 'ok', ...tenant(beta, 'viewer') });
  });

  it('ignores tenant values sent as AG-UI context, forwarded props or request headers', async () => {
    const workspaceId = String(workspaceIds.get(alpha));
    const spoof = {
      userId: other.userId,
      organizationId: alpha,
      workspaceId,
      workspaceRole: 'owner',
    };
    const result = await pingResult(user.client, spoof);
    expect(result).toEqual({ status: 'ok', ...tenant(beta, 'viewer') });
  });

  it('answers 403 once the member is removed, although the session still names the workspace', async () => {
    const body = { memberIdOrEmail: user.email, organizationId: beta };
    await auth.api.removeMember({ headers: other.client.headers(), body });
    const current = await auth.api.getSession({ headers: user.client.headers() });
    expect(current?.session.activeOrganizationId).toBe(beta);
    await expectRefused(user.client, 403, 'not-a-member');
  });

  it('answers 403 and logs a configuration error for a comma-separated or unknown role', async () => {
    await post(user.client, '/organization/set-active', { organizationId: alpha });
    const current = await auth.api.getSession({ headers: user.client.headers() });
    const token = String(current?.session.token);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const role of ['owner,viewer', 'superuser']) {
      const row = and(eq(member.userId, user.userId), eq(member.organizationId, alpha));
      await controlDb.update(member).set({ role }).where(row);
      log.mockClear();
      await expectRefused(user.client, 403, 'invalid-role');
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).toContain('configuration error');
      expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    }
    log.mockRestore();
  });

  it('answers 403 and runs no agent while the registry row is missing or not active (TEN-002)', async () => {
    const owner = await signIn('registry');
    const row = eq(workspaceRegistry.organizationId, await createWorkspace(owner.client, 'gamma'));
    // Neither column may reach a resolution, a response or a log line.
    const hidden = { dbTokenCiphertext: 'ciphertext-never-shown', statusDetail: 'detail-hidden' };
    const logs = (['error', 'warn', 'info', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const results = [];
    const statuses = ['provisioning', 'migrating', 'failed', 'suspended', 'deleting'] as const;
    for (const workspaceStatus of statuses) {
      const set = { status: workspaceStatus, ...hidden };
      await controlDb.update(workspaceRegistry).set(set).where(row);
      results.push(await resolver.resolve(owner.client.headers()));
      expect(results.at(-1)).toEqual({ status: 'workspace-unavailable', workspaceStatus });
      await expectRefused(owner.client, 403, 'workspace-unavailable');
    }

    await controlDb.delete(workspaceRegistry).where(row);
    results.push(await resolver.resolve(owner.client.headers()));
    expect(results.at(-1)).toEqual({ status: 'workspace-not-provisioned' });
    await expectRefused(owner.client, 403, 'workspace-not-provisioned');

    const seen = JSON.stringify([results, logs.map((log) => log.mock.calls)]);
    for (const value of Object.values(hidden)) expect(seen).not.toContain(value);
    for (const log of logs) log.mockRestore();
  });
});
