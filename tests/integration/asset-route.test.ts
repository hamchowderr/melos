import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMock } from '@copilotkit/aimock';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assetStorageKey } from '../../src/server/services/assets/asset-storage';
import type { LocalAssetStorage } from '../../src/server/services/assets/local-asset-storage';
import { BASE_URL, prepareTestEnvironment, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;
type AssetRoute = typeof import('../../src/app/api/assets/local/[...key]/route');

const ROOT = 'data/test-asset-route-workspaces/assets';
const stamp = Date.now();
let mock: LLMock;
let authRoute: { POST: Handler };
let assetRoute: AssetRoute;
let auth: typeof import('../../src/server/auth/auth').auth;
let storage: LocalAssetStorage;

beforeAll(async () => {
  mock = await prepareTestEnvironment('asset-route');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  assetRoute = await import('../../src/app/api/assets/local/[...key]/route');
  ({ auth } = await import('../../src/server/auth/auth'));
  const selection = await import('../../src/server/services/assets/get-asset-storage');
  storage = selection.getLocalAssetStorage() as LocalAssetStorage;
});

afterAll(async () => {
  await mock?.stop();
});

async function post(client: TestClient, path: string, body: object) {
  const response = await client.call(authRoute.POST, 'POST', `/api/auth${path}`, body);
  expect(response.status, path).toBe(200);
  return (await response.json()) as { id: string; user: { id: string } };
}

/** A signed-in user who owns a new active workspace, with its registry workspace id. */
async function owner(label: string) {
  const client = new TestClient();
  const email = `${label}-${stamp}@example.test`;
  const password = 'integration-password-123';
  const { user } = await post(client, '/sign-up/email', { email, password, name: label });
  await post(client, '/sign-in/email', { email, password });
  const slug = `${label}-${stamp}`;
  const { id } = await post(client, '/organization/create', { name: label, slug });
  await post(client, '/organization/set-active', { organizationId: id });
  const { tenantContextResolver } = await import('../../src/server/services/tenant-context');
  const tenant = await tenantContextResolver.resolve(client.headers());
  const workspaceId = tenant.status === 'ok' ? tenant.context.workspaceId : '';
  return { client, userId: user.id, organizationId: id, workspaceId };
}

/** Calls the route as a browser would for a URL from the storage, with the session cookie. */
function call(client: TestClient, method: 'GET' | 'PUT', url: string, body?: string, type = '') {
  const target = new URL(url, BASE_URL);
  const key = target.pathname.split('/').slice(4).map(decodeURIComponent);
  const headers = { cookie: client.cookie, ...(type ? { 'content-type': type } : {}) };
  const request = new Request(target, { method, headers, body });
  return assetRoute[method](request, { params: Promise.resolve({ key }) });
}

const expectRefusal = async (response: Response, status: number, error: string) =>
  expect([response.status, await response.json()]).toEqual([status, { error }]);

describe('AST-INT-001: the local asset route serves a key only in its own workspace', () => {
  let alpha: Awaited<ReturnType<typeof owner>>;
  let beta: Awaited<ReturnType<typeof owner>>;
  let key = '';
  const urls = async (workspaceId: string, storageKey: string) => ({
    upload: (
      await storage.createUploadUrl({
        workspaceId,
        storageKey,
        contentType: 'audio/mpeg',
        expiresInSeconds: 900,
      })
    ).url,
    download: (await storage.createDownloadUrl({ workspaceId, storageKey, expiresInSeconds: 300 }))
      .url,
  });

  beforeAll(async () => {
    alpha = await owner('asset-alpha');
    beta = await owner('asset-beta');
    key = assetStorageKey(alpha.workspaceId, 'ast_01K0000000000000000000000A', 'song.mp3');
  });

  it('uploads and downloads through signed URLs, refusing a bad or expired signature', async () => {
    const { upload, download } = await urls(alpha.workspaceId, key);
    expect((await call(alpha.client, 'PUT', upload, 'alpha audio', 'audio/mpeg')).status).toBe(204);
    const response = await call(alpha.client, 'GET', download);
    expect([response.status, await response.text()]).toEqual([200, 'alpha audio']);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'audio/mpeg',
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
    });
    await expectRefusal(await call(new TestClient(), 'GET', download), 401, 'unauthenticated');
    await expectRefusal(await call(alpha.client, 'GET', `${download}x`), 403, 'invalid-signature');
    const retyped = await call(alpha.client, 'PUT', upload, 'html', 'text/html');
    await expectRefusal(retyped, 403, 'invalid-signature');

    const brief = await storage.createDownloadUrl({
      workspaceId: alpha.workspaceId,
      storageKey: key,
      expiresInSeconds: 1,
    });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 1_000 });
    const expired = await call(alpha.client, 'GET', brief.url);
    vi.useRealTimers();
    await expectRefusal(expired, 403, 'expired');
  });

  it('answers 403 in workspace B for workspace A keys and a viewer upload, touching no file', async () => {
    const { upload, download } = await urls(alpha.workspaceId, key);
    const read = vi.spyOn(storage, 'read');
    const write = vi.spyOn(storage, 'put');
    const outside = 'key-outside-workspace';
    await expectRefusal(await call(beta.client, 'PUT', upload, 'beta', 'audio/mpeg'), 403, outside);
    await expectRefusal(await call(beta.client, 'GET', download), 403, outside);
    // Route segments as Next.js passes them; a URL parser would already have removed the `..`.
    const params = Promise.resolve({ key: [beta.workspaceId, '..', ...key.split('/')] });
    const traversal = new Request(new URL(download, BASE_URL), {
      headers: { cookie: beta.client.cookie },
    });
    await expectRefusal(await assetRoute.GET(traversal, { params }), 403, outside);

    // A viewer may download but not upload (D-5: catalog:read, catalog:update).
    const role = 'viewer' as const;
    await auth.api.addMember({
      body: { userId: beta.userId, organizationId: alpha.organizationId, role },
    });
    await post(beta.client, '/organization/set-active', { organizationId: alpha.organizationId });
    const viewerUpload = await call(beta.client, 'PUT', upload, 'beta', 'audio/mpeg');
    await expectRefusal(viewerUpload, 403, 'forbidden');
    expect((await call(beta.client, 'GET', download)).status).toBe(200);

    expect(write).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    expect(readFileSync(join(ROOT, key), 'utf8')).toBe('alpha audio');
    expect(existsSync(join(ROOT, beta.workspaceId))).toBe(false);
  });
});
