import { isWorkspaceKey } from '@/server/services/assets/asset-storage';
import { getLocalAssetStorage } from '@/server/services/assets/get-asset-storage';
import { requirePermission } from '@/server/services/permissions';
import { tenantContextResolver } from '@/server/services/tenant-context';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ key: string[] }> };

const refuse = (status: number, error: string) => Response.json({ error }, { status });

/**
 * LocalAssetStorage URLs in development and tests (§7.5). 404 unless local storage is selected;
 * then the session's active workspace (§7.1), a key under that workspace's prefix (AST-001),
 * catalog:read to download or catalog:update to upload (D-5), and a valid, unexpired signature.
 * Every refusal comes before any file is read or written.
 */
async function handle(method: 'GET' | 'PUT', request: Request, { params }: Context) {
  const storage = getLocalAssetStorage();
  if (!storage) return refuse(404, 'not-found');
  const tenant = await tenantContextResolver.resolve(request.headers);
  if (tenant.status !== 'ok') {
    return refuse(tenant.status === 'unauthenticated' ? 401 : 403, tenant.status);
  }
  const { workspaceId } = tenant.context;
  const storageKey = (await params).key.join('/');
  if (!isWorkspaceKey(workspaceId, storageKey)) return refuse(403, 'key-outside-workspace');
  const action = method === 'GET' ? 'read' : 'update';
  if (!requirePermission(tenant.context, { catalog: [action] }).ok) return refuse(403, 'forbidden');

  const query = new URL(request.url).searchParams;
  const contentType = method === 'PUT' ? (request.headers.get('content-type') ?? '') : '';
  const expires = query.get('expires');
  const check = storage.verifyUrl({
    method,
    storageKey,
    contentType,
    expires,
    signature: query.get('signature'),
  });
  if (check !== 'valid') return refuse(403, check);

  if (method === 'PUT') {
    const body = new Uint8Array(await request.arrayBuffer());
    await storage.put({ workspaceId, storageKey, contentType, body });
    return new Response(null, { status: 204 });
  }
  const object = await storage.read({ workspaceId, storageKey });
  if (!object) return refuse(404, 'not-found');
  return new Response(object.body, {
    headers: {
      'content-type': object.contentType,
      'cache-control': 'private, no-store',
      // An uploaded file never runs as a page on the app's origin.
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
    },
  });
}

export const GET = (request: Request, context: Context) => handle('GET', request, context);
export const PUT = (request: Request, context: Context) => handle('PUT', request, context);
