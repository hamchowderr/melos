import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../../drizzle.config';
import { ensureLocalDatabaseDir } from '../../src/server/db/local-database';

const CONTROL_MIGRATIONS = './src/server/db/migrations/control';
const clients: Client[] = [];

async function migratedDatabase(name: string, migrationsFolder = CONTROL_MIGRATIONS) {
  const file = `data/test-${name}.db`;
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${file}${suffix}`, { force: true });
  const url = `file:./${file}`;
  ensureLocalDatabaseDir(url);
  const client = createClient({ url });
  clients.push(client);
  await migrate(drizzle(client), { migrationsFolder });
  return client;
}

async function rows(client: Client, query: string) {
  return (await client.execute(query)).rows;
}

/** Columns (name, type, NOT NULL, default, primary-key position), then indexes, then foreign keys. */
async function describeTable(client: Client, table: string) {
  const columns = (await rows(client, `PRAGMA table_info(${table})`)).map(
    (c) =>
      `${c.name} ${String(c.type).toUpperCase()}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value === null ? '' : ` ${c.dflt_value}`}${c.pk ? ` PK${c.pk}` : ''}`,
  );
  const indexes = [];
  for (const index of await rows(client, `PRAGMA index_list(${table})`)) {
    if (index.origin === 'pk') continue;
    const keys = (await rows(client, `PRAGMA index_xinfo(${index.name})`)).filter((k) => k.key);
    const cols = keys.map((key) => `${key.name}${key.desc ? ' DESC' : ''}`).join(', ');
    indexes.push(`${index.unique ? 'UNIQUE ' : ''}${index.name}(${cols})`);
  }
  const foreignKeys = (await rows(client, `PRAGMA foreign_key_list(${table})`)).map(
    (fk) => `FK ${fk.from} -> ${fk.table}(${fk.to}) ON DELETE ${fk.on_delete}`,
  );
  return [...columns, ...indexes.sort(), ...foreignKeys.sort()];
}

afterAll(() => {
  for (const client of clients) client.close();
});

describe('AUTH-INT-006: control-plane migrations are separate from workspace migrations', () => {
  let db: Client;

  beforeAll(async () => {
    db = await migratedDatabase('control-migrations');
  });

  it('reads only the control schema files and the control migrations folder', () => {
    expect(config.schema).toEqual([
      './src/server/db/schema/auth.ts',
      './src/server/db/schema/control.ts',
    ]);
    expect(config.out).toBe(CONTROL_MIGRATIONS);
    const outside = readdirSync('src/server/db/migrations').filter(
      (entry) => !['control', 'workspace', 'runtime'].includes(entry),
    );
    expect(outside).toEqual([]);
  });

  it('holds the Better Auth and control tables and no workspace table', async () => {
    const tables = await rows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
    );
    expect(tables.map((table) => table.name).join(' ')).toBe(
      'account control_audit_log invitation member migration_runs organization session user verification workspace_member_settings workspace_registry',
    );
  });

  it('creates the §4.1 columns, defaults, keys and indexes', async () => {
    expect(await describeTable(db, 'workspace_registry')).toEqual([
      'id TEXT NOT NULL PK1',
      'organization_id TEXT NOT NULL',
      'database_name TEXT NOT NULL',
      'database_url TEXT NOT NULL',
      'db_token_ciphertext TEXT',
      'schema_version INTEGER NOT NULL 0',
      "status TEXT NOT NULL 'provisioning'",
      'status_detail TEXT',
      'created_at TEXT NOT NULL',
      'updated_at TEXT NOT NULL',
      'attempt_id TEXT',
      'UNIQUE workspace_registry_database_name_unique(database_name)',
      'UNIQUE workspace_registry_organization_id_unique(organization_id)',
      'FK organization_id -> organization(id) ON DELETE RESTRICT',
    ]);
    expect(await describeTable(db, 'workspace_member_settings')).toEqual([
      'organization_id TEXT NOT NULL PK1',
      'user_id TEXT NOT NULL PK2',
      "timezone TEXT NOT NULL 'UTC'",
      'updated_at TEXT NOT NULL',
      'FK organization_id -> organization(id) ON DELETE CASCADE',
      'FK user_id -> user(id) ON DELETE CASCADE',
    ]);
    expect(await describeTable(db, 'migration_runs')).toEqual([
      'id TEXT NOT NULL PK1',
      'batch_id TEXT NOT NULL',
      'workspace_id TEXT NOT NULL',
      'from_version INTEGER NOT NULL',
      'to_version INTEGER NOT NULL',
      'status TEXT NOT NULL',
      'error TEXT',
      'started_at TEXT',
      'finished_at TEXT',
      'idx_migration_runs_batch(batch_id, status)',
      'idx_migration_runs_workspace(workspace_id, started_at DESC)',
      'FK workspace_id -> workspace_registry(id) ON DELETE CASCADE',
    ]);
    expect(await describeTable(db, 'control_audit_log')).toEqual([
      'id TEXT NOT NULL PK1',
      'actor_user_id TEXT',
      'organization_id TEXT',
      'action TEXT NOT NULL',
      'target_type TEXT NOT NULL',
      'target_id TEXT NOT NULL',
      'before_json TEXT',
      'after_json TEXT',
      'occurred_at TEXT NOT NULL',
      'idx_control_audit_org_time(organization_id, occurred_at DESC)',
    ]);
  });

  it('rejects statuses outside the §4.1 CHECK constraints', async () => {
    await db.execute(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('org_1', 'Org', 'org', 0)",
    );
    await db.execute(
      "INSERT INTO workspace_registry (id, organization_id, database_name, database_url, created_at, updated_at) VALUES ('ws_1', 'org_1', 'melos-ws-1', 'file:./ws.db', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')",
    );
    await expect(
      db.execute("UPDATE workspace_registry SET status = 'archived' WHERE id = 'ws_1'"),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      db.execute(
        "INSERT INTO migration_runs (id, batch_id, workspace_id, from_version, to_version, status) VALUES ('mig_1', 'b1', 'ws_1', 0, 1, 'done')",
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('keeps control_audit_log append-only', async () => {
    await db.execute(
      "INSERT INTO control_audit_log (id, action, target_type, target_id, occurred_at) VALUES ('cad_1', 'workspace.provisioned', 'workspace', 'ws_1', '2026-09-12T00:00:00.000Z')",
    );
    await expect(
      db.execute("UPDATE control_audit_log SET action = 'workspace.deleted' WHERE id = 'cad_1'"),
    ).rejects.toThrow('control_audit_log is append-only');
    await expect(db.execute("DELETE FROM control_audit_log WHERE id = 'cad_1'")).rejects.toThrow(
      'control_audit_log is append-only',
    );
  });

  it('migrates a database created by the first control migration forward without re-running it', async () => {
    // The migrator reads only journal entries, so a journal holding just the Better Auth
    // migration reproduces the migrations folder on main at 71c8bb5.
    const journal = JSON.parse(readFileSync(`${CONTROL_MIGRATIONS}/meta/_journal.json`, 'utf8'));
    const mainFolder = mkdtempSync(join(tmpdir(), 'melos-main-migrations-'));
    cpSync(CONTROL_MIGRATIONS, mainFolder, { recursive: true });
    const mainJournal = { ...journal, entries: journal.entries.slice(0, 1) };
    writeFileSync(join(mainFolder, 'meta/_journal.json'), JSON.stringify(mainJournal));

    const legacy = await migratedDatabase('control-migrations-legacy', mainFolder);
    rmSync(mainFolder, { recursive: true, force: true });
    const before = await rows(legacy, 'SELECT hash, created_at FROM __drizzle_migrations');
    expect(before).toHaveLength(1);

    await migrate(drizzle(legacy), { migrationsFolder: CONTROL_MIGRATIONS });
    const after = await rows(
      legacy,
      'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at',
    );
    expect(after).toHaveLength(journal.entries.length);
    expect(after[0]).toEqual(before[0]);
    expect(await describeTable(legacy, 'control_audit_log')).toHaveLength(10);
  });
});
