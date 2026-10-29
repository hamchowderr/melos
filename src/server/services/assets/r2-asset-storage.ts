import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { R2Config } from '../../env';
import { type AssetStorage, requireExpiry, requireWorkspaceKey } from './asset-storage';

/**
 * An R2 request that failed, carrying the S3 error name and HTTP status only, never the message,
 * which can repeat the request (§3.1).
 */
export class AssetStorageError extends Error {
  readonly code = 'ASSET_STORAGE_FAILED';

  constructor(
    readonly errorName: string,
    readonly status: number | undefined,
  ) {
    super(`Asset storage request failed: ${errorName}${status ? ` (${status})` : ''}`);
    this.name = 'AssetStorageError';
  }
}

type S3Failure = { name?: string; $metadata?: { httpStatusCode?: number } };
const statusOf = (error: unknown) => (error as S3Failure)?.$metadata?.httpStatusCode;

async function sent<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw new AssetStorageError((error as S3Failure)?.name ?? 'Error', statusOf(error));
  }
}

/**
 * Production and previews (AST-002, §7.5): one private bucket per environment, reached through the
 * S3 API with region `auto` and the account endpoint (U-27). URLs are presigned on the server with
 * SigV4 and are bound to their key. Every method checks the key's workspace prefix before any
 * request (AST-001). `endpoint` replaces the account endpoint, with path-style URLs, for tests.
 */
export function createR2AssetStorage(config: R2Config & { endpoint?: string }): AssetStorage {
  const client = new S3Client({
    region: 'auto',
    endpoint: config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: config.endpoint !== undefined,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const Bucket = config.bucket;
  return {
    provider: 'r2',
    async createUploadUrl({ workspaceId, storageKey, contentType, expiresInSeconds }) {
      requireWorkspaceKey(workspaceId, storageKey);
      requireExpiry(expiresInSeconds);
      const command = new PutObjectCommand({ Bucket, Key: storageKey, ContentType: contentType });
      return { url: await getSignedUrl(client, command, { expiresIn: expiresInSeconds }) };
    },
    async createDownloadUrl({ workspaceId, storageKey, expiresInSeconds }) {
      requireWorkspaceKey(workspaceId, storageKey);
      requireExpiry(expiresInSeconds);
      const command = new GetObjectCommand({ Bucket, Key: storageKey });
      return { url: await getSignedUrl(client, command, { expiresIn: expiresInSeconds }) };
    },
    async put({ workspaceId, storageKey, contentType, body }) {
      requireWorkspaceKey(workspaceId, storageKey);
      const command = new PutObjectCommand({
        ...{ Bucket, Key: storageKey, ContentType: contentType, Body: body },
      });
      await sent(() => client.send(command));
    },
    async delete({ workspaceId, storageKey }) {
      requireWorkspaceKey(workspaceId, storageKey);
      await sent(() => client.send(new DeleteObjectCommand({ Bucket, Key: storageKey })));
    },
    async head({ workspaceId, storageKey }) {
      requireWorkspaceKey(workspaceId, storageKey);
      try {
        const object = await client.send(new HeadObjectCommand({ Bucket, Key: storageKey }));
        const contentType = object.ContentType ?? 'application/octet-stream';
        return { contentType, size: object.ContentLength ?? 0 };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw new AssetStorageError((error as S3Failure)?.name ?? 'Error', statusOf(error));
      }
    },
  };
}
