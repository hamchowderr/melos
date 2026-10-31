import { readFileSync } from 'node:fs';
import { type Client, createClient } from '@libsql/client';
import { eq, getTableColumns, getTableName } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  EMBEDDED_RUNTIME_MIGRATIONS_FILE,
  generateEmbeddedMigrations,
  RUNTIME_EMBED,
} from '../../src/server/db/embed-workspace-migrations';
import { FOREIGN_KEY_RULES } from '../../src/server/db/fk-rules.generated';
import { migrateRuntimeDatabase } from '../../src/server/db/runtime-database';
import { agentThreadRuns, agentThreads } from '../../src/server/db/schema/runtime';
import { readSchemaVersion } from '../../src/server/db/workspace-migrations';
import { createIntegrityGuard } from '../../src/server/services/integrity-guard';
import { expectForeignKeysIntact, openWithoutForeignKeys } from './support';

const NOW = '2026-10-31T00:00:00.000Z';
const thread = (threadId: string) => ({
  threadId,
  resourceId: 'ws_a:user_a',
  workspaceId: 'ws_a',
  agentId: 'melos',
  createdAt: NOW,
  updatedAt: NOW,
});
const run = (threadId: string, runId: string, seq: number) => ({
  threadId,
  runId,
  seq,
  status: 'finished' as const,
  eventsJson: '[]',
  createdAt: NOW,
});

function memoryClient(): Client {
  const client = createClient({ url: ':memory:' });
  onTestFinished(() => client.close());
  return client;
}

describe('melos-agent-runtime runner tables (§4.1)', () => {
  it('embeds the runtime SQL folder byte for byte', () => {
    expect(generateEmbeddedMigrations(RUNTIME_EMBED.folder, RUNTIME_EMBED)).toBe(
      readFileSync(EMBEDDED_RUNTIME_MIGRATIONS_FILE, 'utf8'),
    );
  });

  it('migrates once, and a second instance migrating the same database is a no-op', async () => {
    const client = memoryClient();
    await migrateRuntimeDatabase(client);
    await migrateRuntimeDatabase(client);
    expect(await readSchemaVersion(client)).toBe(1);
  });

  it('matches the drizzle tables column for column', async () => {
    const client = memoryClient();
    await migrateRuntimeDatabase(client);
    for (const table of [agentThreads, agentThreadRuns]) {
      const { rows } = await client.execute(`PRAGMA table_info(${getTableName(table)})`);
      // drizzle marks a primary key NOT NULL; SQLite reports a TEXT PRIMARY KEY as nullable.
      const migrated = rows.map((row) => [row.name, row.type, Boolean(row.notnull || row.pk)]);
      const declared = Object.values(getTableColumns(table)).map((column) => [
        column.name,
        column.getSQLType().toUpperCase(),
        column.notNull,
      ]);
      expect(declared).toEqual(migrated);
    }
  });

  it('refuses a run row without its thread, as the runner tables check (§7.9)', async () => {
    const client = memoryClient();
    await migrateRuntimeDatabase(client);
    const insert = client.execute({
      sql: "INSERT INTO agent_threads (thread_id, resource_id, workspace_id, agent_id, active_run_id, created_at, updated_at) VALUES ('t', 'r', 'w', 'melos', 'run_1', ?, ?)",
      args: [NOW, NOW],
    });
    await expect(insert).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe('DAT-INT-001: IntegrityGuard on melos-agent-runtime', () => {
  const open = () =>
    openWithoutForeignKeys((fresh) =>
      migrateRuntimeDatabase((fresh as LibSQLDatabase & { $client: Client }).$client),
    );

  it('declares the run-to-thread cascade from PRAGMA foreign_key_list', () => {
    expect(FOREIGN_KEY_RULES.runtime).toEqual([
      expect.objectContaining({
        table: 'agent_thread_runs',
        parentTable: 'agent_threads',
        onDelete: 'CASCADE',
      }),
    ]);
  });

  it('refuses a run of a missing thread and cascades a thread delete to its runs', async () => {
    const db = await open();
    onTestFinished(() => db.$client.close());
    const guard = createIntegrityGuard(FOREIGN_KEY_RULES.runtime);
    await expectForeignKeysIntact(db, async (tx) => {
      await expect(
        guard.insert(tx, agentThreadRuns, [run('t_missing', 'r1', 1)]),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        table: 'agent_thread_runs',
        counts: { agent_threads: 1 },
      });
      await guard.insert(tx, agentThreads, [thread('t_a'), thread('t_b')]);
      await guard.insert(tx, agentThreadRuns, [run('t_a', 'r1', 1), run('t_a', 'r2', 2)]);
      await guard.insert(tx, agentThreadRuns, [run('t_b', 'r3', 1)]);
      await guard.delete(tx, agentThreads, eq(agentThreads.threadId, 't_a'));
      const left = await tx.select({ runId: agentThreadRuns.runId }).from(agentThreadRuns);
      expect(left).toEqual([{ runId: 'r3' }]);
    });
  });
});
