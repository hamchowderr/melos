import { type Client, createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { getServerEnv } from '../env';
import { ensureLocalDatabaseDir } from './local-database';
import { EMBEDDED_RUNTIME_MIGRATIONS } from './runtime-migrations.generated';
import * as runtimeSchema from './schema/runtime';
import { applyWorkspaceMigrations, readSchemaVersion } from './workspace-migrations';

export type RuntimeDatabase = LibSQLDatabase<typeof runtimeSchema>;

const LATEST_RUNTIME_VERSION = EMBEDDED_RUNTIME_MIGRATIONS.at(-1)?.version ?? 0;

/**
 * Brings melos-agent-runtime's runner tables to the latest embedded version. Two instances can
 * start at once: the one that loses the race fails its CREATE TABLE, so a failure counts as done
 * when the database already reached the latest version. Mastra's own tables are created by
 * `@mastra/libsql`, never here.
 */
export async function migrateRuntimeDatabase(client: Client): Promise<void> {
  try {
    await applyWorkspaceMigrations(client, { migrations: EMBEDDED_RUNTIME_MIGRATIONS });
  } catch (error) {
    if ((await readSchemaVersion(client)) !== LATEST_RUNTIME_VERSION) throw error;
  }
}

let opened: Promise<RuntimeDatabase> | undefined;

/**
 * The runner's database: the same melos-agent-runtime database Mastra storage uses (§7.3,
 * TEN-006), never the control or a workspace database. Opened and migrated once per server
 * instance; a failed open is not kept, so the next request tries again.
 */
export function getRuntimeDatabase(): Promise<RuntimeDatabase> {
  opened ??= (async () => {
    const { url, authToken } = getServerEnv().agentDatabase;
    ensureLocalDatabaseDir(url);
    const client = createClient({ url, authToken });
    try {
      await migrateRuntimeDatabase(client);
    } catch (error) {
      client.close();
      throw error;
    }
    return drizzle(client, { schema: runtimeSchema });
  })().catch((error: unknown) => {
    opened = undefined;
    throw error;
  });
  return opened;
}
