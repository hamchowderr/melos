import { ALLOWED_CONTENT_TYPES, MAX_ASSET_BYTES } from '@/lib/dto/assets';
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
 * A PUT must carry an allowed content type (so a stored type is always a safe header) and at most
 * MAX_ASSET_BYTES. Every refusal comes before any file is read or written.
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
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) return refuse(415, 'content-type-not-allowed');
    if (Number(request.headers.get('content-length') ?? 0) > MAX_ASSET_BYTES) {
      return refuse(413, 'too-large');
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > MAX_ASSET_BYTES) return refuse(413, 'too-large');
    await storage.put({ workspaceId, storageKey, contentType, body });
    return new Response(null, { status: 204 });
  }
  const object = await storage.read({ workspaceId, storageKey });
  if (!object) return refuse(404, 'not-found');
  const headers = {
    'content-type': object.contentType,
    'cache-control': 'private, no-store',
    // An uploaded file never runs as a page on the app's origin.
    'content-security-policy': 'sandbox',
    'x-content-type-options': 'nosniff',
    // AudioPlayer seeks to the preview start, which media elements do with range requests, as R2
    // serves them.
    'accept-ranges': 'bytes',
  };
  const size = object.body.byteLength;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  if (!range || (!range[1] && !range[2])) return new Response(object.body, { headers });
  const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  }
  return new Response(object.body.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}` },
  });
}

export const GET = (request: Request, context: Context) => handle('GET', request, context);
export const PUT = (request: Request, context: Context) => handle('PUT', request, context);
