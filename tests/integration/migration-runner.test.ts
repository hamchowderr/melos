import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { type Client, createClient, type Transaction, type TransactionMode } from '@libsql/client';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  controlAuditLog,
  migrationRuns,
  workspaceRegistry,
} from '../../src/server/db/schema/control';
import type { WorkspaceMigration } from '../../src/server/db/workspace-migrations';
import { openWithoutForeignKeys } from './support';

type Row = typeof workspaceRegistry.$inferSelect;
type Env = typeof import('../../src/server/env');
type Hosts = typeof import('../../src/server/db/workspace-hosts');
type Migrations = typeof import('../../src/server/db/workspace-migrations');
type Provisioner = typeof import('../../src/server/services/workspace-provisioner');
type Runner = typeof import('../../src/server/db/migration-runner');
type Result = Awaited<ReturnType<Runner['runMigrationBatch']>>;

const DATA_DIR = 'data/test-migration-runner';
const CONTROL_MIGRATIONS = './src/server/db/migrations/control';
const TOKEN = 'workspace-jwt-that-must-never-be-stored';
/** The melos-control database the runner uses: in memory, or a file for the lock test. */
let control: LibSQLDatabase & { $client: Client };
let runMigrationBatch: Runner['runMigrationBatch'];
let provisioner: Provisioner;
let env: Env;
let hosts: Hosts;
let migrations: Migrations;
let base: WorkspaceMigration[] = [];
const serverEnv = vi.fn<Env['getServerEnv']>();
const createHost = vi.fn<Hosts['createWorkspaceHost']>();
const applyMigrations = vi.fn<Migrations['applyWorkspaceMigrations']>();
const writeIf = vi.fn<Provisioner['writeIf']>();
const clients: Client[] = [];

/**
 * The in-memory control database has one connection, and libSQL refuses every other call while a
 * transaction holds it; calls wait for the transaction here instead. This does not model a database
 * file, whose pooled connections fail with SQLITE_BUSY while another holds the lock: the lock test
 * uses a file.
 */
function waitForTransactions(client: Client): Client {
  let idle = Promise.resolve();
  async function whenIdle<T>(work: () => Promise<T>): Promise<T> {
    for (let open = idle; ; open = idle) {
      await open;
      if (open === idle) return work();
    }
  }
  const begin = (mode?: TransactionMode) =>
    whenIdle(async () => {
      const ended = Promise.withResolvers<void>();
      idle = ended.promise;
      const tx = await client.transaction(mode).catch((error: unknown) => {
        ended.resolve();
        throw error;
      });
      for (const end of ['commit', 'rollback'] as const) {
        const settle = tx[end].bind(tx);
        tx[end] = () => settle().finally(ended.resolve);
      }
      return tx;
    });
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'transaction') return begin;
      if (typeof value !== 'function') return value;
      const call = (...args: unknown[]) => value.apply(target, args);
      return key === 'execute' || key === 'batch'
        ? (...args: unknown[]) => whenIdle(async () => call(...args))
        : call;
    },
  });
}

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.env.MELOS_WORKSPACE_DATA_DIR = DATA_DIR;
  const migrationsFolder = CONTROL_MIGRATIONS;
  const opened = await openWithoutForeignKeys((db) => migrate(db, { migrationsFolder }));
  // DAT-INT-001: one in-memory connection with foreign keys off.
  control = drizzle(waitForTransactions(opened.$client));
  // Getters, so the lock test can give the runner a database file instead.
  vi.doMock('../../src/server/db/client', () => ({
    get controlDb() {
      return control;
    },
    get controlDatabaseClient() {
      return control.$client;
    },
  }));
  // Each mock calls the original until a test overrides it.
  vi.doMock('../../src/server/env', async (original) => {
    env = await original<Env>();
    return { ...env, getServerEnv: serverEnv.mockImplementation(env.getServerEnv) };
  });
  vi.doMock('../../src/server/db/workspace-hosts', async (original) => {
    hosts = await original<Hosts>();
    const create = createHost.mockImplementation(hosts.createWorkspaceHost);
    return { ...hosts, createWorkspaceHost: create };
  });
  vi.doMock('../../src/server/db/workspace-migrations', async (original) => {
    migrations = await original<Migrations>();
    const apply = applyMigrations.mockImplementation(migrations.applyWorkspaceMigrations);
    return { ...migrations, applyWorkspaceMigrations: apply };
  });
  vi.doMock('../../src/server/services/workspace-provisioner', async (original) => {
    provisioner = await original<Provisioner>();
    return { ...provisioner, writeIf: writeIf.mockImplementation(provisioner.writeIf) };
  });
  ({ runMigrationBatch } = await import('../../src/server/db/migration-runner'));
  base = migrations.readWorkspaceMigrations();
});

afterAll(() => {
  for (const client of clients) client.close();
  control?.$client.close();
});

/** The workspace migrations plus `count` versions, each creating a table. */
const withProbes = (count: number): WorkspaceMigration[] => [
  ...base,
  ...Array.from({ length: count }, (_, index) => {
    const version = base.length + index + 1;
    const name = `runner_probe_${version}`;
    return { version, name, file: name, statements: [`CREATE TABLE ${name} (id INTEGER)`] };
  }),
];

const run = (probes: number, batchId = ulid()) =>
  runMigrationBatch({ batchId, migrations: withProbes(probes) });

const outcomeOf = (result: Result, { id }: Row) =>
  result.workspaces.find(({ workspaceId }) => workspaceId === id);

const statusesOf = (results: Result[], row: Row) =>
  results.map((result) => outcomeOf(result, row)?.status).toSorted();

/** A workspace's outcome as `<status> <from>><to> <error> <registry status>`. */
const lineOf = (result: Result) => (row: Row) => {
  const outcome = outcomeOf(result, row);
  if (!outcome) return undefined;
  const { status, fromVersion, toVersion, error, workspaceStatus } = outcome;
  return `${status} ${fromVersion}>${toVersion} ${error ?? '-'} ${workspaceStatus}`;
};

/** An expected line, its versions counted from the latest workspace migration. */
const line = (status: string, from: number, to: number, error = '-', registry = 'active') =>
  `${status} ${base.length + from}>${base.length + to} ${error} ${registry}`;

/** An organization's workspace, provisioned `active` at the latest workspace migration. */
async function createWorkspace(slug: string): Promise<Row> {
  const organizationId = `org_${slug}`;
  const values = sql`(${organizationId}, ${slug}, ${slug}, 0)`;
  await control.run(sql`INSERT INTO organization (id, name, slug, created_at) VALUES ${values}`);
  const row = await provisioner.provisionWorkspace(organizationId);
  expect(row).toMatchObject({ status: 'active', schemaVersion: base.length });
  return row;
}

const rowOf = async (id: string) =>
  (await control.select().from(workspaceRegistry).where(eq(workspaceRegistry.id, id)))[0];

const runsOf = (workspaceId: string, batchId?: string) => {
  const inBatch = batchId === undefined ? undefined : eq(migrationRuns.batchId, batchId);
  const where = and(eq(migrationRuns.workspaceId, workspaceId), inBatch);
  const order = [migrationRuns.startedAt, migrationRuns.id];
  return control
    .select()
    .from(migrationRuns)
    .where(where)
    .orderBy(...order);
};

async function openWorkspace({ databaseUrl }: Row): Promise<Client> {
  const client = createClient({ url: databaseUrl });
  clients.push(client);
  await client.execute('PRAGMA foreign_keys = OFF');
  return client;
}

const rows = async (client: Client, query: string) =>
  (await client.execute(query)).rows.map((row) => ({ ...row }));

/** DAT-INT-001: with foreign keys off, no violation on melos-control or on the workspaces. */
async function expectIntact(workspaces: Row[]) {
  expect(await control.all(sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 0 }]);
  expect(await control.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  for (const workspace of workspaces) {
    const db = await openWorkspace(workspace);
    expect(await rows(db, 'PRAGMA foreign_keys')).toEqual([{ foreign_keys: 0 }]);
    expect(await rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  }
}

/** Holds the next migration call until the returned function runs: before it, or after `version`. */
function holdNextMigration(version?: number): () => void {
  const held = Promise.withResolvers<void>();
  applyMigrations.mockImplementationOnce(async (client, options = {}) => {
    if (version === undefined) await held.promise;
    const onApplied = async (migration: WorkspaceMigration) => {
      await options.onApplied?.(migration);
      if (migration.version === version) await held.promise;
    };
    return migrations.applyWorkspaceMigrations(client, { ...options, onApplied });
  });
  return () => held.resolve();
}

/** The runner a melos-control transaction belongs to, set by startTogether. */
const runnerOf = new AsyncLocalStorage<number>();

/**
 * Starts two runners of a one-workspace batch. Each runner's second melos-control transaction, the
 * claim after its audit row, waits until both have requested theirs, so both read the row before
 * either claims; the claims then begin together and contend for the database as they would.
 */
function startTogether(start: () => Promise<Result>): Promise<Result[]> {
  const began = [0, 0];
  const claiming = new Set<number>();
  const bothClaiming = Promise.withResolvers<void>();
  const transaction = control.transaction.bind(control);
  type Work = Parameters<typeof transaction>[0];
  const gated = async (work: Work, config?: Parameters<typeof transaction>[1]) => {
    const runner = runnerOf.getStore();
    if (runner !== undefined && began[runner] === 1) {
      claiming.add(runner);
      if (claiming.size === 2) bothClaiming.resolve();
      await bothClaiming.promise;
    }
    const counted: Work = async (tx) => {
      if (runner !== undefined) began[runner] += 1;
      return work(tx);
    };
    return transaction(counted, config);
  };
  const spy = vi.spyOn(control, 'transaction').mockImplementation(gated as typeof transaction);
  const runs = [runnerOf.run(0, start), runnerOf.run(1, start)];
  return Promise.all(runs).finally(() => spy.mockRestore());
}

// First in the file, while `shared` is the only workspace.
describe('ADR-033: MigrationRunner claims workspaces like provisioning attempts do (§7.2)', () => {
  let shared: Row;

  it('lets one of two runners started together claim a workspace; the other records no run', async () => {
    shared = await createWorkspace('shared');
    applyMigrations.mockClear();
    const results = await startTogether(() => run(1));
    expect(statusesOf(results, shared)).toEqual(['succeeded', 'unclaimed']);
    expect(applyMigrations).toHaveBeenCalledOnce();
    const won = results.find((result) => outcomeOf(result, shared)?.status === 'succeeded');
    const succeeded = { batchId: won?.batchId, fromVersion: base.length, status: 'succeeded' };
    expect(await runsOf(shared.id)).toMatchObject([{ ...succeeded, error: null }]);
    const migrated = { status: 'active', schemaVersion: base.length + 1 };
    expect(await rowOf(shared.id)).toMatchObject(migrated);
    await expectIntact([shared]);
  });

  it('lets one of two reruns take over a silent claim; the silent runner then writes nothing', async () => {
    applyMigrations.mockClear();
    const release = holdNextMigration();
    const batchId = ulid();
    const silent = run(2, batchId);
    await vi.waitFor(() => expect(applyMigrations).toHaveBeenCalledOnce());
    const [held] = await runsOf(shared.id, batchId);
    expect(held).toMatchObject({ status: 'running', fromVersion: base.length + 1 });
    // Provisioning refuses a migrating row and leaves it to the runner's claim.
    const retry = provisioner.provisionWorkspace(shared.organizationId);
    await expect(retry).rejects.toThrow(`${shared.id} is migrating`);
    const stale = new Date(Date.now() - provisioner.STALE_CLAIM_MS).toISOString();
    const byId = eq(workspaceRegistry.id, shared.id);
    await control.update(workspaceRegistry).set({ updatedAt: stale }).where(byId);

    applyMigrations.mockClear();
    const reruns = await startTogether(() => run(2, batchId));
    expect(statusesOf(reruns, shared)).toEqual(['succeeded', 'unclaimed']);
    expect(applyMigrations).toHaveBeenCalledOnce();
    release();
    expect(lineOf(await silent)(shared)).toBe(line('failed', 1, 2, 'ClaimLost'));
    const runs = await runsOf(shared.id, batchId);
    const expired = { id: held.id, status: 'failed', error: 'ClaimExpired' };
    expect(runs).toMatchObject([expired, { status: 'succeeded' }]);
    const taken = { status: 'active', schemaVersion: base.length + 2, attemptId: runs[1].id };
    expect(await rowOf(shared.id)).toMatchObject(taken);
    await expectIntact([shared]);
  });

  it('stops without failing a workspace that a delete marks deleting mid-run, and never revives it', async () => {
    const doomed = await createWorkspace('doomed');
    const release = holdNextMigration(base.length + 1);
    const batchId = ulid();
    const running = run(2, batchId);
    const recorded = { status: 'migrating', schemaVersion: base.length + 1 };
    await vi.waitFor(async () => expect(await rowOf(doomed.id)).toMatchObject(recorded));
    // The runner holds the file open, and Windows would refuse to remove it.
    const local = hosts.createWorkspaceHost({ kind: 'local', dataDir: DATA_DIR });
    createHost.mockReturnValueOnce({ ...local, delete: async () => {} });
    const marked = (await provisioner.deleteWorkspaceDatabase(doomed.organizationId)) as Row;
    release();
    expect(lineOf(await running)(doomed)).toBe(line('failed', 0, 2, 'ClaimLost', 'deleting'));
    const kept = { ...recorded, status: 'deleting', statusDetail: null };
    expect(await rowOf(doomed.id)).toMatchObject(kept);
    const lost = { batchId, status: 'failed', error: 'ClaimLost' };
    expect(await runsOf(doomed.id)).toMatchObject([lost]);
    expect(lineOf(await run(2, batchId))(doomed)).toBeUndefined();
    expect(await rowOf(doomed.id)).toMatchObject(kept);
    await expectIntact([doomed]);
    // The organization delete's transaction removes the row, cascading its runs (ADR-030).
    await control.transaction((tx) => provisioner.removeWorkspace(tx, marked, null));
    expect([await rowOf(doomed.id), await runsOf(doomed.id)]).toEqual([undefined, []]);
    expect(await control.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('on a control database file, retries a claim the write lock refuses; a claim still refused reports unclaimed', async () => {
    const memory = control;
    const url = `file:./${DATA_DIR}/control.db`;
    mkdirSync(DATA_DIR, { recursive: true });
    // Separate clients, as separate processes: without WAL (melos-lb3), a read after a refused write
    // can keep a lock until its client closes (ADR-033).
    const connect = () => {
      control = drizzle(createClient({ url }));
      clients.push(control.$client);
    };
    try {
      connect();
      await migrate(control, { migrationsFolder: CONTROL_MIGRATIONS });
      const filed = await createWorkspace('filed');
      control.$client.close();
      // Two runners claim together: the second BEGIN IMMEDIATE meets the first's lock and retries.
      connect();
      const together = await startTogether(() => run(1));
      expect(statusesOf(together, filed)).toEqual(['succeeded', 'unclaimed']);
      control.$client.close();

      // Another client, as another process, holds the write lock through every retry of a claim.
      connect();
      const other = createClient({ url });
      clients.push(other);
      const transaction = control.transaction.bind(control);
      let [calls, lock] = [0, undefined as Transaction | undefined];
      const locking = async (work: Parameters<typeof transaction>[0]) => {
        // The runner's first transaction appends its audit row; its second is the claim.
        calls += 1;
        if (calls === 2) lock = await other.transaction('write');
        return transaction(work);
      };
      vi.spyOn(control, 'transaction').mockImplementation(locking as typeof transaction);
      const refused = await run(2);
      await lock?.rollback();
      expect(lineOf(refused)(filed)).toBe(line('unclaimed', 1, 2));
      const statuses = (await runsOf(filed.id)).map((entry) => entry.status);
      const kept = { status: 'active', schemaVersion: base.length + 1 };
      expect([statuses, await rowOf(filed.id)]).toMatchObject([['succeeded'], kept]);
      expect(await control.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    } finally {
      control = memory;
    }
  });
});

describe('TEN-005: MigrationRunner migrates every active workspace in resumable batches (§7.2)', () => {
  const trio: Row[] = [];

  it('brings three workspaces from N to N+1, each with a succeeded run, after migration.batch_started', async () => {
    for (const slug of ['one', 'two', 'three']) trio.push(await createWorkspace(slug));
    const batchId = ulid();
    const result = await run(1, batchId);
    const target = base.length + 1;
    expect(result).toMatchObject({ batchId, toVersion: target });
    expect(trio.map(lineOf(result))).toEqual(trio.map(() => line('succeeded', 0, 1)));
    const succeeded = { batchId, fromVersion: base.length, toVersion: target, status: 'succeeded' };
    for (const workspace of trio) {
      expect(await rowOf(workspace.id)).toMatchObject({ status: 'active', schemaVersion: target });
      const finished = { error: null, finishedAt: expect.any(String) };
      expect(await runsOf(workspace.id)).toMatchObject([{ ...succeeded, ...finished }]);
      const db = await openWorkspace(workspace);
      const version = await rows(db, 'SELECT max(version) AS version FROM schema_migrations');
      expect(version).toEqual([{ version: target }]);
    }
    const byBatch = eq(controlAuditLog.targetId, batchId);
    const audit = await control.select().from(controlAuditLog).where(byBatch);
    const started = { action: 'migration.batch_started', targetType: 'migration_batch' };
    const unattributed = { actorUserId: null, organizationId: null, beforeJson: null };
    const afterJson = `{"to_version":${target}}`;
    expect(audit).toMatchObject([{ ...started, ...unattributed, afterJson }]);
    await expectIntact(trio);
  });

  it('fails only the workspace the migration fails on; a rerun after the fix migrates only it and skips the rest unwritten', async () => {
    const [one, two, three] = trio;
    const probe = `runner_probe_${base.length + 2}`;
    const db = await openWorkspace(two);
    await db.execute(`CREATE TABLE ${probe} (id INTEGER)`);
    const batchId = ulid();
    const code = 'LibsqlBatchError SQLITE_ERROR';
    const [succeeded, failed] = [line('succeeded', 1, 2), line('failed', 1, 2, code, 'failed')];
    expect(trio.map(lineOf(await run(2, batchId)))).toEqual([succeeded, failed, succeeded]);
    const detail = `batch ${batchId} failed: ${code}`;
    const kept = { status: 'failed', schemaVersion: base.length + 1, statusDetail: detail };
    expect(await rowOf(two.id)).toMatchObject(kept);

    await db.execute(`DROP TABLE ${probe}`);
    const read = ({ databaseName }: Row) => readFileSync(`${DATA_DIR}/${databaseName}.db`);
    const before = [one, three].map(read);
    applyMigrations.mockClear();
    const skipped = line('skipped', 2, 2);
    expect(trio.map(lineOf(await run(2, batchId)))).toEqual([skipped, succeeded, skipped]);
    expect(applyMigrations).toHaveBeenCalledOnce();
    expect([one, three].map(read)).toEqual(before);
    const oneRuns = [{ status: 'succeeded' }, { status: 'skipped', fromVersion: base.length + 2 }];
    const twoRuns = [
      { status: 'failed', error: code },
      { status: 'succeeded', error: null },
    ];
    const recorded = [await runsOf(one.id, batchId), await runsOf(two.id, batchId)];
    expect(recorded).toMatchObject([oneRuns, twoRuns]);
    await expectIntact(trio);
  });

  it('keeps schema_version at the version the database committed when a registry write after it fails', async () => {
    const lagging = await createWorkspace('lagging');
    const probe = `runner_probe_${base.length + 2}`;
    const db = await openWorkspace(lagging);
    await db.execute(`CREATE TABLE ${probe} (id INTEGER)`);
    const versions = async () => {
      const [{ version }] = await rows(db, 'SELECT max(version) AS version FROM schema_migrations');
      return [(await rowOf(lagging.id)).schemaVersion, version];
    };
    const committed = [base.length + 1, base.length + 1];
    // The registry write after version N+1 commits fails once, with an error that is not a lock.
    writeIf.mockRejectedValueOnce(
      Object.assign(new Error('write failed'), { code: 'SQLITE_IOERR' }),
    );
    const batchId = ulid();
    const refused = line('failed', 0, 2, 'Error SQLITE_IOERR', 'failed');
    expect(lineOf(await run(2, batchId))(lagging)).toBe(refused);
    expect(await versions()).toEqual(committed);

    // A registry behind its database, as a crash between a commit and its write leaves it, catches
    // up before the next version fails.
    const byId = eq(workspaceRegistry.id, lagging.id);
    await control.update(workspaceRegistry).set({ schemaVersion: base.length }).where(byId);
    const next = line('failed', 0, 2, 'LibsqlBatchError SQLITE_ERROR', 'failed');
    expect(lineOf(await run(2, batchId))(lagging)).toBe(next);
    expect(await versions()).toEqual(committed);
    await db.execute(`DROP TABLE ${probe}`);
    expect(lineOf(await run(2, batchId))(lagging)).toBe(line('succeeded', 1, 2));
    expect(await versions()).toEqual([base.length + 2, base.length + 2]);
    expect(await rowOf(lagging.id)).toMatchObject({ status: 'active' });
    await expectIntact([lagging]);
  });

  it('stores only error names and codes; the provisioning retry takes back a workspace a batch failed', async () => {
    const leaky = await createWorkspace('leaky');
    const databaseUrl = `file:${DATA_DIR}/${TOKEN}/${leaky.databaseName}.db`;
    // libSQL names the path of a file it cannot open in its error message.
    const local = { kind: 'local', dataDir: DATA_DIR } as const;
    expect(() => hosts.openWorkspaceDatabase(local, { ...leaky, databaseUrl })).toThrow(TOKEN);
    const byId = eq(workspaceRegistry.id, leaky.id);
    await control.update(workspaceRegistry).set({ databaseUrl }).where(byId);
    const batchId = ulid();
    const result = await run(2, batchId);
    expect(lineOf(result)(leaky)).toBe(line('failed', 0, 2, 'Error', 'failed'));
    const { statusDetail } = await rowOf(leaky.id);
    const stored = JSON.stringify([statusDetail, await runsOf(leaky.id), result]);
    expect([stored.includes(TOKEN), stored.includes(DATA_DIR)]).toEqual([false, false]);

    // `--all-failed` claims the row the batch failed and provisions it on the database it names; a
    // rerun of the batch then migrates it as an active workspace.
    const { runProvisionCommand } = await import('../../scripts/workspace-provision');
    const printed: string[] = [];
    expect(await runProvisionCommand(['--all-failed'], (text) => printed.push(text))).toBe(0);
    expect(printed).toEqual([`${leaky.organizationId} active`]);
    const retried = {
      status: 'active',
      databaseUrl: leaky.databaseUrl,
      schemaVersion: base.length,
    };
    expect(await rowOf(leaky.id)).toMatchObject(retried);
    expect(lineOf(await run(2, batchId))(leaky)).toBe(line('succeeded', 0, 2));
    await expectIntact([leaky]);
  });

  it('refuses a batch while the workspace host is unconfigured, writing no registry, run or audit row', async () => {
    const snapshot = async () => [
      await control.select().from(workspaceRegistry).orderBy(workspaceRegistry.id),
      await control.$count(migrationRuns),
      await control.$count(controlAuditLog),
    ];
    const before = await snapshot();
    const missing = ['TURSO_API_TOKEN', 'MELOS_WORKSPACE_TOKEN_KEY'];
    const workspaceHost = { kind: 'unconfigured', missing } as const;
    serverEnv.mockReturnValueOnce({ ...env.getServerEnv(), workspaceHost });
    await expect(run(3)).rejects.toMatchObject({ name: 'WorkspaceHostConfigError', missing });
    expect(await snapshot()).toEqual(before);
  });
});
