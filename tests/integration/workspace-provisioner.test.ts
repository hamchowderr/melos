import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { type Client, createClient } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { member } from '../../src/server/db/schema/auth';
import { controlAuditLog, workspaceRegistry } from '../../src/server/db/schema/control';
import { openWithoutForeignKeys, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;
type Row = typeof workspaceRegistry.$inferSelect;
type Hosts = typeof import('../../src/server/db/workspace-hosts');
type Migrations = typeof import('../../src/server/db/workspace-migrations');
type Provisioner = typeof import('../../src/server/services/workspace-provisioner');
type Command = typeof import('../../scripts/workspace-provision');

const DATA_DIR = 'data/test-workspace-provisioner';
const TOKEN = 'workspace-jwt-that-must-never-be-stored';
const FIXTURE = 'docs/fixtures/northstar-demo.json';
const SETTINGS_COLUMNS = ['id', 'follow_up_interval_days', 'updated_by'];
const TEMPLATE_COLUMNS = 'name report_type preset_key config_json is_system created_by updated_by';
const TEMPLATES_QUERY = `SELECT ${TEMPLATE_COLUMNS.replaceAll(' ', ',')} FROM report_templates`;
const pick = (columns: string[]) => (row: Record<string, unknown>) =>
  Object.fromEntries(columns.map((column) => [column, row[column]]));
/** The fixture's provisioner-owned workspace rows (provisionerOwned), without ids and timestamps. */
const { workspace: fixture } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const SEED = {
  settings: fixture.workspace_settings.map(pick(SETTINGS_COLUMNS)),
  templates: fixture.report_templates.map(pick(TEMPLATE_COLUMNS.split(' '))),
};

let control: Awaited<ReturnType<typeof openWithoutForeignKeys>>;
let authRoute: { POST: Handler };
let provisionWorkspace: Provisioner['provisionWorkspace'];
let STALE_CLAIM_MS: Provisioner['STALE_CLAIM_MS'];
let deleteWorkspaceDatabase: Provisioner['deleteWorkspaceDatabase'];
let runProvisionCommand: Command['runProvisionCommand'];
let hosts: Hosts;
let migrations: Migrations;
const createHost = vi.fn<Hosts['createWorkspaceHost']>();
const applyMigrations = vi.fn<Migrations['applyWorkspaceMigrations']>();
const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
const owner = new TestClient();
let ownerId = '';
const clients: Client[] = [];

const post = (path: string, body: object) =>
  owner.call(authRoute.POST, 'POST', `/api/auth${path}`, body);

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.env.MELOS_WORKSPACE_DATA_DIR = DATA_DIR;
  const migrationsFolder = './src/server/db/migrations/control';
  control = await openWithoutForeignKeys((db) => migrate(db, { migrationsFolder }));
  // One in-memory connection with foreign keys off, as in control-deletes.test.ts (DAT-INT-001).
  const controlClient = { controlDb: control, controlDatabaseClient: control.$client };
  vi.doMock('../../src/server/db/client', () => controlClient);
  vi.doMock('../../src/server/db/workspace-hosts', async (importOriginal) => {
    hosts = await importOriginal<Hosts>();
    const create = createHost.mockImplementation(hosts.createWorkspaceHost);
    return { ...hosts, createWorkspaceHost: create };
  });
  vi.doMock('../../src/server/db/workspace-migrations', async (importOriginal) => {
    migrations = await importOriginal<Migrations>();
    const apply = applyMigrations.mockImplementation(migrations.applyWorkspaceMigrations);
    return { ...migrations, applyWorkspaceMigrations: apply };
  });
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  const provisioner = await import('../../src/server/services/workspace-provisioner');
  ({ provisionWorkspace, STALE_CLAIM_MS, deleteWorkspaceDatabase } = provisioner);
  ({ runProvisionCommand } = await import('../../scripts/workspace-provision'));

  const credentials = { email: 'owner@example.test', password: 'integration-password-123' };
  const signedUp = await post('/sign-up/email', { ...credentials, name: 'Owner' });
  ownerId = ((await signedUp.json()) as { user: { id: string } }).user.id;
  expect((await post('/sign-in/email', credentials)).status).toBe(200);
});

afterAll(() => {
  for (const client of clients) client.close();
  control?.$client.close();
  logged.mockRestore();
});

/** Creates an organization through Better Auth, which succeeds whatever provisioning does (P-23). */
async function createOrganization(slug: string): Promise<Row> {
  expect(await control.all(sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 0 }]);
  const created = await post('/organization/create', { name: slug, slug });
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };
  expect(await control.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  const members = await control.select().from(member).where(eq(member.organizationId, id));
  expect(members).toMatchObject([{ userId: ownerId, role: 'owner' }]);
  const byOrganization = eq(workspaceRegistry.organizationId, id);
  const registered = await control.select().from(workspaceRegistry).where(byOrganization);
  expect(registered).toHaveLength(1);
  return registered[0];
}

/** Opens a workspace file with foreign keys off. Never deleted mid-run: Windows keeps it locked. */
async function openWorkspace({ databaseUrl }: Row): Promise<Client> {
  const client = createClient({ url: databaseUrl });
  clients.push(client);
  await client.execute('PRAGMA foreign_keys = OFF');
  return client;
}

const rows = async (client: Client, query: string) =>
  (await client.execute(query)).rows.map((row) => ({ ...row }));

const seedRows = async (client: Client) => ({
  settings: await rows(client, `SELECT ${SETTINGS_COLUMNS} FROM workspace_settings`),
  templates: await rows(client, TEMPLATES_QUERY),
});

const latest = () => migrations.readWorkspaceMigrations().at(-1)?.version;

describe('TEN-004: creating an organization provisions its workspace database (§7.2)', () => {
  it('registers one active workspace whose database is migrated, seeded and audited', async () => {
    const workspace = await createOrganization('first');
    expect(workspace.id).toMatch(/^ws_[0-9A-HJKMNP-TV-Z]{26}$/);
    const name = `melos-ws-${workspace.id.slice('ws_'.length)}`;
    const database = { databaseName: name, databaseUrl: `file:${DATA_DIR}/${name}.db` };
    expect(workspace).toMatchObject({ ...database, dbTokenCiphertext: null, statusDetail: null });
    expect(workspace).toMatchObject({ status: 'active', schemaVersion: latest() });

    // DAT-INT-001 on the workspace database; createOrganization checks melos-control.
    const db = await openWorkspace(workspace);
    const version = await rows(db, 'SELECT max(version) AS version FROM schema_migrations');
    expect(version).toEqual([{ version: latest() }]);
    expect(await seedRows(db)).toEqual(SEED);
    expect(await rows(db, 'PRAGMA foreign_keys')).toEqual([{ foreign_keys: 0 }]);
    expect(await rows(db, 'PRAGMA foreign_key_check')).toEqual([]);

    const target = eq(controlAuditLog.targetId, workspace.id);
    const audit = await control.select().from(controlAuditLog).where(target);
    const event = { action: 'workspace.provisioned', targetType: 'workspace', beforeJson: null };
    const { organizationId, createdAt } = workspace;
    expect(audit).toMatchObject([{ ...event, actorUserId: ownerId, organizationId }]);
    // The row as registered, before the host ran, with every column but db_token_ciphertext.
    const registered = { id: workspace.id, organization_id: organizationId, database_name: name };
    const unset = { database_url: '', schema_version: 0, status_detail: null };
    const times = { status: 'provisioning', created_at: createdAt, updated_at: createdAt };
    const claimed = { attempt_id: workspace.attemptId };
    const after = JSON.parse(String(audit[0].afterJson));
    expect(after).toEqual({ ...registered, ...unset, ...times, ...claimed });
  });

  it('gives two organizations distinct databases with identical schemas and seed rows (TEN-001)', async () => {
    const contents = async (workspace: Row) => {
      const db = await openWorkspace(workspace);
      const schema = await rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name');
      return { schema, ...(await seedRows(db)) };
    };
    const pair = [await createOrganization('second'), await createOrganization('third')];
    const names = pair.flatMap((row) => [row.id, row.databaseName, row.databaseUrl]);
    expect(new Set(names).size).toBe(6);
    const first = await contents(pair[0]);
    expect(first.schema.length).toBeGreaterThan(30);
    expect(await contents(pair[1])).toEqual(first);
  });

  it('fails the row with no token when the host throws or is unconfigured (production today); a retry activates it', async () => {
    const local = hosts.createWorkspaceHost({ kind: 'local', dataDir: DATA_DIR });
    const refused = new Error(`refused ${TOKEN}`);
    createHost.mockReturnValueOnce({ ...local, create: () => Promise.reject(refused) });
    const missing = ['TURSO_API_TOKEN', 'TURSO_ORG', 'MELOS_WORKSPACE_TOKEN_KEY'];
    createHost.mockReturnValueOnce(hosts.createWorkspaceHost({ kind: 'unconfigured', missing }));
    const failed = [
      await createOrganization('host-throws'),
      await createOrganization('unconfigured'),
    ];
    expect(failed.map(({ status, statusDetail }) => [status, statusDetail])).toEqual([
      ['failed', 'create_database failed: Error'],
      ['failed', 'create_database failed: WorkspaceHostConfigError'],
    ]);
    expect(JSON.stringify([failed, logged.mock.calls])).not.toContain(TOKEN);

    for (const { id, organizationId, databaseName } of failed) {
      const active = await provisionWorkspace(organizationId);
      expect(active).toMatchObject({ id, databaseName, status: 'active', schemaVersion: latest() });
      expect(await seedRows(await openWorkspace(active))).toEqual(SEED);
    }
  });

  it('resumes a row left provisioning after a migration failed, on the same database', async () => {
    const all = migrations.readWorkspaceMigrations();
    const last = { ...all[all.length - 1], statements: ['SELECT * FROM missing_table'] };
    const broken = [...all.slice(0, -1), last];
    applyMigrations.mockImplementationOnce((client) =>
      migrations.applyWorkspaceMigrations(client, { migrations: broken }),
    );
    const failed = await createOrganization('interrupted');
    const detail = expect.stringMatching(/^migrate failed: \w+ SQLITE_ERROR$/);
    expect(failed).toMatchObject({ status: 'failed', statusDetail: detail });
    const db = await openWorkspace(failed);
    const applied = await rows(db, 'SELECT * FROM schema_migrations ORDER BY version');
    expect(applied).toHaveLength(all.length - 1);

    // A crash mid-provisioning leaves the row provisioning. While its attempt may still be running
    // the row comes back as it is; once the attempt has been silent for STALE_CLAIM_MS it resumes.
    const stuck = eq(workspaceRegistry.id, failed.id);
    await control.update(workspaceRegistry).set({ status: 'provisioning' }).where(stuck);
    const running = await provisionWorkspace(failed.organizationId);
    expect(running).toMatchObject({ status: 'provisioning', attemptId: failed.attemptId });
    const silent = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
    await control.update(workspaceRegistry).set({ updatedAt: silent }).where(stuck);
    const active = await provisionWorkspace(failed.organizationId);
    const resumed = { id: failed.id, databaseUrl: failed.databaseUrl, statusDetail: null };
    expect(active).toMatchObject({ ...resumed, status: 'active', schemaVersion: latest() });
    const reapplied = await rows(db, 'SELECT * FROM schema_migrations ORDER BY version');
    expect(reapplied.slice(0, -1)).toEqual(applied);
    expect(await seedRows(db)).toEqual(SEED);
  });
});

const rowOf = async (organizationId: string) => {
  const byOrganization = eq(workspaceRegistry.organizationId, organizationId);
  return (await control.select().from(workspaceRegistry).where(byOrganization))[0];
};

/** An organization whose provisioning failed because the host was unconfigured. */
async function createFailed(slug: string): Promise<Row> {
  createHost.mockReturnValueOnce(hosts.createWorkspaceHost({ kind: 'unconfigured', missing: [] }));
  const row = await createOrganization(slug);
  expect(row).toMatchObject({ status: 'failed' });
  return row;
}

/** The next host's create waits until the returned function runs, so its attempt keeps the claim. */
function holdNextCreate(): () => void {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  createHost.mockImplementationOnce((setting) => {
    const host = hosts.createWorkspaceHost(setting);
    return { ...host, create: (name: string) => held.then(() => host.create(name)) };
  });
  return release;
}

/** Makes the row's claim stale, as if its attempt had written nothing for STALE_CLAIM_MS. */
const backdate = (id: string) =>
  control
    .update(workspaceRegistry)
    .set({ updatedAt: new Date(Date.now() - STALE_CLAIM_MS).toISOString() })
    .where(eq(workspaceRegistry.id, id));

describe('melos-75e.14: provisioning claims and the operator retry command (§7.2, ADR-032)', () => {
  it('lets exactly one of two overlapping attempts provision; the row ends active, never failed', async () => {
    const { organizationId } = await createFailed('overlap');
    createHost.mockClear();
    applyMigrations.mockClear();
    const release = holdNextCreate();
    const attempts = [provisionWorkspace(organizationId), provisionWorkspace(organizationId)];
    // The other attempt returns the row, still provisioning, while the first holds its claim.
    expect(await Promise.race(attempts)).toMatchObject({ status: 'provisioning' });
    release();
    const statuses = (await Promise.all(attempts)).map((row) => row.status);
    expect(statuses.sort()).toEqual(['active', 'provisioning']);
    expect([createHost.mock.calls.length, applyMigrations.mock.calls.length]).toEqual([1, 1]);
    expect(await rowOf(organizationId)).toMatchObject({ status: 'active', statusDetail: null });
  });

  it('takes over a stale claim; the attempt that lost it writes nothing and returns the row', async () => {
    const { id, organizationId } = await createFailed('stale');
    createHost.mockClear();
    const release = holdNextCreate();
    const slow = provisionWorkspace(organizationId);
    await vi.waitFor(() => expect(createHost).toHaveBeenCalledTimes(1));
    // The slow attempt has written nothing for STALE_CLAIM_MS, so a retry may claim the row.
    await backdate(id);
    const taken = await provisionWorkspace(organizationId);
    expect(taken).toMatchObject({ status: 'active', statusDetail: null });
    release();
    // Its database_url write, and then its `failed` write, match no row: the claim is not its own.
    expect(await slow).toEqual(taken);
    expect(await rowOf(organizationId)).toEqual(taken);
  });

  it('keeps the database of a retry that took over a stale claim when the silent attempt resumes', async () => {
    const { id, organizationId, databaseName } = await createFailed('stale-held');
    createHost.mockClear();
    const releaseSilent = holdNextCreate();
    const silent = provisionWorkspace(organizationId);
    await vi.waitFor(() => expect(createHost).toHaveBeenCalledTimes(1));
    await backdate(id);
    const releaseRetry = holdNextCreate();
    const retry = provisionWorkspace(organizationId);
    await vi.waitFor(() => expect(createHost).toHaveBeenCalledTimes(2));
    releaseSilent();
    // The retry holds the row under its own attempt id and uses the same database, which stays.
    expect(await silent).toEqual(await rowOf(organizationId));
    expect(await rowOf(organizationId)).toMatchObject({ status: 'provisioning' });
    expect(existsSync(`${DATA_DIR}/${databaseName}.db`)).toBe(true);
    releaseRetry();
    const active = await retry;
    expect(active).toMatchObject({ status: 'active', schemaVersion: latest() });
    expect(await seedRows(await openWorkspace(active))).toEqual(SEED);
  });

  it('refuses a delete while a retry holds a live claim; the retry then provisions', async () => {
    const { organizationId } = await createFailed('delete-live');
    createHost.mockClear();
    const release = holdNextCreate();
    const attempt = provisionWorkspace(organizationId);
    await vi.waitFor(() => expect(createHost).toHaveBeenCalledTimes(1));
    const claimed = await rowOf(organizationId);
    const refusal = { name: 'WorkspaceDeleteError', step: 'provisioning_in_progress' };
    await expect(deleteWorkspaceDatabase(organizationId)).rejects.toMatchObject(refusal);
    expect(await rowOf(organizationId)).toEqual(claimed);
    release();
    expect(await attempt).toMatchObject({ status: 'active', statusDetail: null });
  });

  it('deletes past a stale claim; the attempt then deletes the database its create made', async () => {
    const { id, organizationId, databaseName } = await createFailed('delete-stale');
    createHost.mockClear();
    const release = holdNextCreate();
    const attempt = provisionWorkspace(organizationId);
    await vi.waitFor(() => expect(createHost).toHaveBeenCalledTimes(1));
    await backdate(id);
    expect((await post('/organization/delete', { organizationId })).status).toBe(200);
    expect(await rowOf(organizationId)).toBeUndefined();
    release();
    // The create makes the file after the delete; the attempt, finding no row, deletes it.
    await expect(attempt).rejects.toThrow('was deleted while it was provisioning');
    expect(existsSync(`${DATA_DIR}/${databaseName}.db`)).toBe(false);
  });

  it('workspace:provision -- <organizationId> activates a failed workspace', async () => {
    const { organizationId } = await createFailed('command');
    const lines: string[] = [];
    expect(await runProvisionCommand([organizationId], (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([`${organizationId} active`]);
    expect(await rowOf(organizationId)).toMatchObject({
      status: 'active',
      schemaVersion: latest(),
    });
  });

  it('--all-failed retries every failed row, printing ids and statuses only', async () => {
    const created = [await createFailed('all-one'), await createFailed('all-two')];
    const failed = created.sort((a, b) => (a.id < b.id ? -1 : 1));
    const byStatus = eq(workspaceRegistry.status, 'failed');
    const before = await control.select().from(workspaceRegistry).where(byStatus);
    expect(before.map((row) => row.id).sort()).toEqual(failed.map((row) => row.id));
    const local = hosts.createWorkspaceHost({ kind: 'local', dataDir: DATA_DIR });
    createHost.mockReturnValueOnce({ ...local, create: () => Promise.reject(new Error(TOKEN)) });
    const lines: string[] = [];
    expect(await runProvisionCommand(['--all-failed'], (line) => lines.push(line))).toBe(1);
    const [first, second] = failed.map((row) => row.organizationId);
    expect(lines).toEqual([`${first} failed`, `${second} active`]);
    expect(await rowOf(first)).toMatchObject({ statusDetail: 'create_database failed: Error' });
    const printed = JSON.stringify(lines);
    expect([printed.includes(TOKEN), printed.includes('failed:')]).toEqual([false, false]);
  });

  it('runs as the npm script through tsx on a control database file (smoke)', async () => {
    const file = 'data/test-workspace-provision-command.db';
    for (const suffix of ['', '-shm', '-wal']) rmSync(`${file}${suffix}`, { force: true });
    const db = drizzle(createClient({ url: `file:./${file}` }));
    clients.push(db.$client);
    await migrate(db, { migrationsFolder: './src/server/db/migrations/control' });
    const [key, at, detail] = [ulid(), new Date().toISOString(), 'create_database failed: Error'];
    await db.$client.batch([
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('org_cli', 'CLI', 'cli', 0)",
      {
        sql: "INSERT INTO workspace_registry (id, organization_id, database_name, database_url, status, status_detail, created_at, updated_at) VALUES (?, 'org_cli', ?, '', 'failed', ?, ?, ?)",
        args: [`ws_${key}`, `melos-ws-${key}`, detail, at, at],
      },
    ]);
    const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts['workspace:provision'];
    const [runner, ...args] = String(script).split(' ');
    expect(runner).toBe('tsx');
    const run = (url: string) => {
      const env = { ...process.env, VERCEL: '', MELOS_CONTROL_DATABASE_URL: url };
      const tsx = ['node_modules/tsx/dist/cli.mjs', ...args, 'org_cli'];
      return spawnSync(process.execPath, tsx, { env, encoding: 'utf8', timeout: 50_000 });
    };
    const done = run(`file:./${file}`);
    expect([done.status, done.stdout], done.stderr).toEqual([0, 'org_cli active\n']);
    expect(done.stdout + done.stderr).not.toContain(detail);
    const registry = await rows(db.$client, 'SELECT status, status_detail FROM workspace_registry');
    expect(registry).toEqual([{ status: 'active', status_detail: null }]);
    // A remote control database with the local workspace host is refused before any query.
    const refused = run('http://127.0.0.1:9');
    expect([refused.status, refused.stdout], refused.stderr).toEqual([2, '']);
    // libSQL copies an invalid query value into its message; only the name and code are printed.
    const marker = 'secret-looking-marker-never-printed';
    const invalid = run(`file:./${file}?tls=${marker}`);
    expect([invalid.status, invalid.stdout]).toEqual([2, '']);
    expect(invalid.stderr).toMatch(/^Configuration error: LibsqlError URL_\w+$/m);
    expect(invalid.stderr).not.toContain(marker);
  });
});
