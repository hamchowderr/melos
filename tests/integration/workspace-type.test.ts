import type { LLMock } from '@copilotkit/aimock';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWorkspaceType } from '../../src/lib/workspace-type';
import { organization } from '../../src/server/db/schema/auth';
import { prepareTestEnvironment, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;

const stamp = Date.now();
const password = 'integration-password-123';
const owner = new TestClient();
let mock: LLMock;
let authRoute: { POST: Handler };
let controlDb: typeof import('../../src/server/db/client').controlDb;
let count = 0;

async function post(path: string, body: object) {
  const response = await owner.call(authRoute.POST, 'POST', `/api/auth${path}`, body);
  return {
    status: response.status,
    body: (await response.json()) as { id?: string; code?: string },
  };
}

async function create(metadata?: unknown) {
  count += 1;
  const slug = `type-records-${stamp}-${count}`;
  return post('/organization/create', { name: slug, slug, ...(metadata ? { metadata } : {}) });
}

async function storedMetadata(id: string) {
  const [row] = await controlDb
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, id));
  return row?.metadata ?? null;
}

beforeAll(async () => {
  mock = await prepareTestEnvironment('workspace-type');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  ({ controlDb } = await import('../../src/server/db/client'));
  const { auth } = await import('../../src/server/auth/auth');
  const email = `owner-${stamp}@example.test`;
  await auth.api.signUpEmail({ body: { email, password, name: 'Owner' } });
  expect((await post('/sign-in/email', { email, password })).status).toBe(200);
});

afterAll(async () => {
  await mock?.stop();
});

describe('ONB-INT-001: workspace type on organization create and update', () => {
  it('stores the chosen type in organization.metadata', async () => {
    const created = await create({ workspaceType: 'label' });
    expect(created.status).toBe(200);
    expect(readWorkspaceType(await storedMetadata(created.body.id ?? ''))).toBe('label');
  });

  it('creates without metadata, which reads as songwriter (ONB-006)', async () => {
    const created = await create();
    expect(created.status).toBe(200);
    expect(readWorkspaceType(await storedMetadata(created.body.id ?? ''))).toBe('songwriter');
  });

  it.each([[{ workspaceType: 'dj' }], [{ workspaceType: 'label', plan: 'pro' }], [{}]])(
    'refuses create with %j and creates nothing',
    async (metadata) => {
      const before = (await controlDb.select().from(organization)).length;
      const refused = await create(metadata);
      expect(refused).toMatchObject({ status: 400, body: { code: 'INVALID_WORKSPACE_TYPE' } });
      expect((await controlDb.select().from(organization)).length).toBe(before);
    },
  );

  it('refuses an update to an unknown type and keeps the stored one', async () => {
    const created = await create({ workspaceType: 'manager' });
    const organizationId = created.body.id ?? '';
    const refused = await post('/organization/update', {
      organizationId,
      data: { metadata: { workspaceType: 'dj' } },
    });
    expect(refused).toMatchObject({ status: 400, body: { code: 'INVALID_WORKSPACE_TYPE' } });
    expect(readWorkspaceType(await storedMetadata(organizationId))).toBe('manager');
  });
});
