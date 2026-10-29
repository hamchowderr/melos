import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASSET_URL_SECONDS,
  AssetKeyError,
  type AssetStorage,
  assetStorageKey,
  downloadSeconds,
} from '../../src/server/services/assets/asset-storage';
import {
  AssetStorageError,
  createR2AssetStorage,
} from '../../src/server/services/assets/r2-asset-storage';

const ALPHA = 'ws_01K0000000000000000000000A';
const BETA = 'ws_01K0000000000000000000000B';
const key = assetStorageKey(ALPHA, 'ast_01K0000000000000000000000A', 'Song.mp3');
const SECRET = 'r2-secret-access-key-for-test';

/** An in-process S3-compatible stub: objects in memory, every request recorded. */
const objects = new Map<string, { body: Buffer; contentType: string }>();
const requests: { method: string; url: string; authorization?: string }[] = [];
let server: Server;
let storage: AssetStorage;

async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub');
    requests.push({
      method: request.method ?? '',
      url: url.pathname,
      authorization: request.headers.authorization,
    });
    const path = decodeURIComponent(url.pathname);
    if (request.method === 'PUT') {
      const contentType = request.headers['content-type'] ?? 'application/octet-stream';
      objects.set(path, { body: await bodyOf(request), contentType });
      response.writeHead(200, { ETag: '"stub"' }).end();
    } else if (request.method === 'HEAD') {
      const object = objects.get(path);
      if (!object) return void response.writeHead(404).end();
      const headers = { 'Content-Type': object.contentType, 'Content-Length': object.body.length };
      response.writeHead(200, headers).end();
    } else if (request.method === 'DELETE') {
      objects.delete(path);
      response.writeHead(204).end();
    } else {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  storage = createR2AssetStorage({
    ...{
      accountId: 'account',
      accessKeyId: 'key-id',
      secretAccessKey: SECRET,
      bucket: 'melos-test',
    },
    endpoint: `http://127.0.0.1:${port}`,
  });
});

afterAll(() => new Promise((done) => server?.close(done)));

describe('AST-INT-002: R2AssetStorage against an S3-compatible stub', () => {
  it('presigns SigV4 uploads for 900 s, audio downloads for 3600 s and other downloads for 300 s (P-35)', async () => {
    const before = requests.length;
    const upload = new URL(
      (
        await storage.createUploadUrl({
          workspaceId: ALPHA,
          storageKey: key,
          contentType: 'audio/mpeg',
          expiresInSeconds: ASSET_URL_SECONDS.upload,
        })
      ).url,
    );
    const audio = new URL(
      (
        await storage.createDownloadUrl({
          workspaceId: ALPHA,
          storageKey: key,
          expiresInSeconds: downloadSeconds('audio/mpeg'),
        })
      ).url,
    );
    const image = new URL(
      (
        await storage.createDownloadUrl({
          workspaceId: ALPHA,
          storageKey: key,
          expiresInSeconds: downloadSeconds('image/png'),
        })
      ).url,
    );
    for (const [url, seconds] of [
      [upload, '900'],
      [audio, '3600'],
      [image, '300'],
    ] as const) {
      expect(url.pathname).toBe(`/melos-test/${key}`);
      expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      expect(url.searchParams.get('X-Amz-Expires')).toBe(seconds);
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(
        /^key-id\/\d{8}\/auto\/s3\/aws4_request$/,
      );
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      expect(url.toString()).not.toContain(SECRET);
    }
    // Signing is local: no request reached storage.
    expect(requests.length).toBe(before);
  });

  it('puts, heads and deletes an object, and heads a missing one as null', async () => {
    const body = new TextEncoder().encode('ID3 audio bytes');
    await storage.put({ workspaceId: ALPHA, storageKey: key, contentType: 'audio/mpeg', body });
    expect(await storage.head({ workspaceId: ALPHA, storageKey: key })).toEqual({
      contentType: 'audio/mpeg',
      size: body.length,
    });
    expect(requests.at(-1)?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=key-id\//);
    await storage.delete({ workspaceId: ALPHA, storageKey: key });
    expect(await storage.head({ workspaceId: ALPHA, storageKey: key })).toBeNull();
  });

  it('refuses a key outside the workspace before any request, and an expiry R2 does not accept', async () => {
    const before = requests.length;
    const calls = [
      () =>
        storage.createUploadUrl({
          workspaceId: BETA,
          storageKey: key,
          contentType: 'audio/mpeg',
          expiresInSeconds: 900,
        }),
      () =>
        storage.createDownloadUrl({ workspaceId: BETA, storageKey: key, expiresInSeconds: 300 }),
      () =>
        storage.put({
          workspaceId: BETA,
          storageKey: key,
          contentType: 'audio/mpeg',
          body: new Uint8Array(),
        }),
      () => storage.delete({ workspaceId: BETA, storageKey: key }),
      () => storage.head({ workspaceId: BETA, storageKey: key }),
      () => storage.head({ workspaceId: ALPHA, storageKey: `${ALPHA}/../${BETA}/x` }),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(AssetKeyError);
    expect(requests.length).toBe(before);
    for (const expiresInSeconds of [0, 604_801, 1.5]) {
      await expect(
        storage.createDownloadUrl({ workspaceId: ALPHA, storageKey: key, expiresInSeconds }),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('reports a failed request by S3 error name and status only', async () => {
    const unreachable = createR2AssetStorage({
      ...{
        accountId: 'account',
        accessKeyId: 'key-id',
        secretAccessKey: SECRET,
        bucket: 'melos-test',
      },
      endpoint: 'http://127.0.0.1:1',
    });
    const failure = unreachable.put({
      workspaceId: ALPHA,
      storageKey: key,
      contentType: 'audio/mpeg',
      body: new Uint8Array(),
    });
    await expect(failure).rejects.toBeInstanceOf(AssetStorageError);
    await expect(failure).rejects.not.toThrow(SECRET);
  });
});
