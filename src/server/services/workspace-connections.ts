import type { Client } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { controlDb } from '../db/client';
import { workspaceRegistry } from '../db/schema/control';
import { WORKSPACE_TABLES, workspaceSettings } from '../db/schema/workspace.generated';
import { openWorkspaceDatabase } from '../db/workspace-hosts';
import { getServerEnv } from '../env';
import { errorCode } from '../error-code';

/** A workspace database (§4.2, §4.3) through the generated drizzle tables. */
export type WorkspaceDatabase = LibSQLDatabase<typeof WORKSPACE_TABLES> & { $client: Client };

/** A workspace database that could not be opened or read. `code` is a name and code, never a message. */
export class WorkspaceConnectionError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly code: string,
  ) {
    super(`Workspace ${workspaceId} database is unavailable: ${code}`);
    this.name = 'WorkspaceConnectionError';
  }
}

/**
 * One client per workspace id (§7.2). @libsql/client keeps the URL and the token in private (`#`)
 * fields, so neither leaves this map through the database it returns.
 */
const connections = new Map<string, Promise<WorkspaceDatabase>>();

/**
 * Runs `work` and replaces any error with a WorkspaceConnectionError holding its name and code:
 * control-plane and libSQL messages may name a URL, a file path or a token.
 */
export async function sanitized<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkspaceConnectionError) throw error;
    throw new WorkspaceConnectionError(workspaceId, errorCode(error));
  }
}

function open(workspaceId: string): Promise<WorkspaceDatabase> {
  return sanitized(workspaceId, async () => {
    const { id, status, databaseName, databaseUrl, dbTokenCiphertext } = workspaceRegistry;
    const [row] = await controlDb
      .select({ databaseName, databaseUrl, dbTokenCiphertext })
      .from(workspaceRegistry)
      .where(and(eq(id, workspaceId), eq(status, 'active')));
    if (!row) throw new WorkspaceConnectionError(workspaceId, 'WorkspaceNotActive');
    const client = openWorkspaceDatabase(getServerEnv().workspaceHost, row);
    return drizzle(client, { schema: WORKSPACE_TABLES });
  });
}

/**
 * The database of the workspace a TenantContextResolver context names. The resolver checks the
 * registry status on every request; this cache does not. A first use reads the `active` row and opens
 * the client with the decrypted token; a failed open is not kept, so the next call tries again.
 */
export function getWorkspaceDatabase(workspaceId: string): Promise<WorkspaceDatabase> {
  const cached = connections.get(workspaceId);
  if (cached) return cached;
  const opening = open(workspaceId);
  connections.set(workspaceId, opening);
  opening.catch(() => {
    if (connections.get(workspaceId) === opening) connections.delete(workspaceId);
  });
  return opening;
}

/** Closes and forgets a workspace's client: its token is dropped and a local file released. */
export async function closeWorkspaceDatabase(workspaceId: string): Promise<void> {
  const cached = connections.get(workspaceId);
  connections.delete(workspaceId);
  (await cached?.catch(() => undefined))?.$client.close();
}

/**
 * Reads the workspace settings through the workspace's own connection (the ping tool's check). A
 * query error leaves only as a name and code, as it must from every service (§7.2).
 */
export function checkWorkspaceDatabase(workspaceId: string): Promise<void> {
  return sanitized(workspaceId, async () => {
    const database = await getWorkspaceDatabase(workspaceId);
    await database.select({ id: workspaceSettings.id }).from(workspaceSettings).limit(1);
  });
}
