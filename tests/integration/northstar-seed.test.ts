import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openWithoutForeignKeys, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;
type Tables = Record<string, Record<string, unknown>[]>;
type Seed = typeof import('../../src/server/db/seed/northstar');
type Command = typeof import('../../scripts/seed-demo');

const DATA_DIR = 'data/test-northstar-seed';
const PASSWORD = 'northstar-seed-password-never-printed';
const MIGRATIONS = './src/server/db/migrations/control';
const SIX_DAYS = 6 * 86_400_000;
const fixture = JSON.parse(readFileSync('docs/fixtures/northstar-demo.json', 'utf8'));
const { keys } = fixture as { keys: Record<string, string> };
const ORGANIZATION_ID = keys['organization:NORTHSTAR'];

/** The fixture's tables in `scope`, apart from the provisioner-owned ones. */
const seededTables = (scope: 'control' | 'workspace') =>
  Object.keys(fixture[scope]).filter(
    (t) => !fixture.provisionerOwned.tables.includes(`${scope}.${t}`),
  );
const fixtureRows = (scope: 'control' | 'workspace'): Tables =>
  Object.fromEntries(seededTables(scope).map((table) => [table, fixture[scope][table]]));

let control: Awaited<ReturnType<typeof openWithoutForeignKeys>>;
let workspace: Client;
let authRoute: { POST: Handler };
let seed: Seed;
let runSeedDemoCommand: Command['runSeedDemoCommand'];
const clients: Client[] = [];

const open = (url: string) => clients[clients.push(createClient({ url })) - 1];
const rows = async (client: Client, query: string) =>
  (await client.execute(query)).rows.map((row) => ({ ...row }));
async function dump(client: Client, tables: string[], order = ' ORDER BY rowid'): Promise<Tables> {
  const dumped: Tables = {};
  for (const table of tables)
    dumped[table] = await rows(client, `SELECT * FROM "${table}"${order}`);
  return dumped;
}
/** Every table of the database, FTS5 shadow tables included, for a before-and-after comparison. */
async function snapshot(client: Client): Promise<Tables> {
  const tables = await rows(client, "SELECT name FROM sqlite_master WHERE type = 'table'");
  return dump(client, tables.map(({ name }) => String(name)).sort(), '');
}
const registryOf = async (client: Client) =>
  (await rows(client, 'SELECT * FROM workspace_registry'))[0];

/** `tables` with every ISO timestamp, calendar date and Better Auth epoch value 6 days later. */
function sixDaysLater(tables: Tables): Tables {
  const move = ([column, value]: [string, unknown]) => {
    if (typeof value === 'number' && column.endsWith('_at')) return [column, value + SIX_DAYS];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return [column, value];
    const moved = new Date(Date.parse(value) + SIX_DAYS).toISOString();
    return [column, value.length === 10 ? moved.slice(0, 10) : moved];
  };
  const later = Object.entries(tables).map(([table, list]) => [
    table,
    list.map((row) => Object.fromEntries(Object.entries(row).map(move))),
  ]);
  return Object.fromEntries(later);
}

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.env.MELOS_WORKSPACE_DATA_DIR = `${DATA_DIR}/workspaces`;
  // One in-memory connection with foreign keys off, as in workspace-provisioner.test.ts (DAT-INT-001).
  control = await openWithoutForeignKeys((db) => migrate(db, { migrationsFolder: MIGRATIONS }));
  const controlClient = { controlDb: control, controlDatabaseClient: control.$client };
  vi.doMock('../../src/server/db/client', () => controlClient);
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  seed = await import('../../src/server/db/seed/northstar');
  ({ runSeedDemoCommand } = await import('../../scripts/seed-demo'));
  const seeded = await seed.seedNorthstar({ password: PASSWORD, seedDate: '2026-09-14' });
  expect(seeded).toMatchObject({ status: 'seeded', organizationId: ORGANIZATION_ID, dateShift: 0 });
  workspace = open(String((await registryOf(control.$client)).database_url));
  await workspace.execute('PRAGMA foreign_keys = OFF');
});

afterAll(() => {
  for (const client of clients) client.close();
  control?.$client.close();
});

describe('melos-cqn.1: the Northstar Demo Catalog seed (§8 phase 3)', () => {
  it('writes rows equal to the fixture for 2026-09-14; provisioner rows keep their own ids', async () => {
    expect(await dump(control.$client, seededTables('control'))).toEqual(fixtureRows('control'));
    expect(await dump(workspace, seededTables('workspace'))).toEqual(fixtureRows('workspace'));
    const registry = await registryOf(control.$client);
    expect(registry).toMatchObject({ organization_id: ORGANIZATION_ID, status: 'active' });
    const settings = 'SELECT id, follow_up_interval_days, updated_by FROM workspace_settings';
    const { id, follow_up_interval_days, updated_by } = fixture.workspace.workspace_settings[0];
    const provisionedSettings = [{ id, follow_up_interval_days, updated_by }];
    expect(await rows(workspace, settings)).toEqual(provisionedSettings);
    const columns = ['name', 'report_type', 'preset_key', 'config_json', 'is_system'];
    const query = `SELECT id, ${columns} FROM report_templates ORDER BY rowid`;
    const templates = await rows(workspace, query);
    const pick = (row: Record<string, unknown>) => columns.map((column) => row[column]);
    expect(templates.map(pick)).toEqual(fixture.workspace.report_templates.map(pick));
    const provisioned = [registry.id, ...templates.map(({ id }) => id)];
    expect(provisioned.filter((id) => Object.values(keys).includes(String(id)))).toEqual([]);

    const audit = await rows(
      control.$client,
      'SELECT * FROM control_audit_log ORDER BY occurred_at',
    );
    // The seed runs without a session, so neither row names an acting user (§4.1).
    const common = { actor_user_id: null, organization_id: ORGANIZATION_ID };
    const added = {
      action: 'member.added',
      target_type: 'member',
      target_id: keys['member:JORDAN'],
    };
    const role = { before_json: null, after_json: '{"role":"owner"}' };
    const provisionedAudit = { action: 'workspace.provisioned', target_id: registry.id };
    expect(audit).toMatchObject([
      { ...common, ...added, ...role, occurred_at: '2026-08-03T16:00:00.000Z' },
      { ...common, ...provisionedAudit },
    ]);
  });

  it('signs Jordan Taylor in with the seeded credential, the only owner, in America/Los_Angeles', async () => {
    const { email } = fixture.control.user[0];
    const client = new TestClient();
    const signIn = (password: string) =>
      client.call(authRoute.POST, 'POST', '/api/auth/sign-in/email', { email, password });
    expect((await signIn('not-the-demo-password')).status).toBe(401);
    expect((await signIn(PASSWORD)).status).toBe(200);
    const where = `WHERE organization_id = '${ORGANIZATION_ID}'`;
    const members = await rows(control.$client, `SELECT user_id, role FROM member ${where}`);
    expect(members).toEqual([{ user_id: keys.usr_JORDAN, role: 'owner' }]);
    const zone = `SELECT user_id, timezone FROM workspace_member_settings ${where}`;
    const settings = await rows(control.$client, zone);
    expect(settings).toEqual([{ user_id: keys.usr_JORDAN, timezone: 'America/Los_Angeles' }]);
    const [credential] = await rows(control.$client, 'SELECT * FROM account');
    expect(credential).toMatchObject({ provider_id: 'credential', account_id: keys.usr_JORDAN });
    expect(String(credential.password)).not.toContain(PASSWORD);
  });

  it('derives catalog_search as validate.mjs does, writes no audit_log row and keeps every key', async () => {
    const search = 'SELECT * FROM catalog_search ORDER BY entity_type, entity_id';
    const indexed = await rows(workspace, search);
    expect(indexed).toHaveLength(10);
    // validate.mjs's own statements, run over the same catalog rows and rolled back.
    const script = readFileSync('docs/fixtures/validate.mjs', 'utf8');
    const statements = script.match(/INSERT INTO catalog_search[^`]+/g) ?? [];
    expect(statements).toHaveLength(2);
    const rebuild = await workspace.transaction('write');
    try {
      await rebuild.execute('DELETE FROM catalog_search');
      for (const statement of statements) await rebuild.execute(statement);
      const derived = (await rebuild.execute(search)).rows.map((row) => ({ ...row }));
      expect(derived).toEqual(indexed);
    } finally {
      await rebuild.rollback();
    }
    expect(await rows(workspace, 'SELECT count(*) AS n FROM audit_log')).toEqual([{ n: 0 }]);
    for (const client of [control.$client, workspace]) {
      expect(await rows(client, 'PRAGMA foreign_keys')).toEqual([{ foreign_keys: 0 }]);
      expect(await rows(client, 'PRAGMA foreign_key_check')).toEqual([]);
    }
  });

  it('refuses a second seed for the same organization id and changes nothing', async () => {
    const before = [await snapshot(control.$client), await snapshot(workspace)];
    const again = await seed.seedNorthstar({ password: PASSWORD, seedDate: '2026-09-20' });
    expect(again).toEqual({ status: 'exists', organizationId: ORGANIZATION_ID });
    expect([await snapshot(control.$client), await snapshot(workspace)]).toEqual(before);
  });

  it('takes today in America/Los_Angeles by default and refuses a bad date or password with 2', async () => {
    const [last, next] = ['2026-09-15T06:59:59.999Z', '2026-09-15T07:00:00.000Z'];
    const today = (at: string) => seed.dateIn('America/Los_Angeles', new Date(at));
    expect([today(last), today(next)]).toEqual(['2026-09-14', '2026-09-15']);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('MELOS_DEMO_PASSWORD', PASSWORD);
    expect(await runSeedDemoCommand(['--date', '2026-02-30'])).toBe(2);
    expect(await runSeedDemoCommand(['2026-09-20'])).toBe(2);
    vi.stubEnv('MELOS_DEMO_PASSWORD', 'short');
    expect(await runSeedDemoCommand([])).toBe(2);
    vi.unstubAllEnvs();
    expect(JSON.stringify(logged.mock.calls)).not.toContain(PASSWORD);
    logged.mockRestore();
  });

  it('db:seed-demo -- --date 2026-09-20 moves every time value by 6 days and keeps every id (smoke)', async () => {
    const file = `${DATA_DIR}/command-control.db`;
    const commandControl = open(`file:./${file}`);
    await migrate(drizzle(commandControl), { migrationsFolder: MIGRATIONS });
    const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts['db:seed-demo'];
    const [runner, ...args] = String(script).split(' ');
    expect(runner).toBe('tsx');
    const run = (url: string, ...flags: string[]) => {
      const workspaces = `${DATA_DIR}/command-workspaces`;
      const variables = { MELOS_CONTROL_DATABASE_URL: url, MELOS_WORKSPACE_DATA_DIR: workspaces };
      const env = { ...process.env, ...variables, VERCEL: '', MELOS_DEMO_PASSWORD: PASSWORD };
      const tsx = ['node_modules/tsx/dist/cli.mjs', ...args, ...flags];
      return spawnSync(process.execPath, tsx, { env, encoding: 'utf8', timeout: 50_000 });
    };
    const done = run(`file:./${file}`, '--date', '2026-09-20');
    expect(done.status, done.stderr).toBe(0);
    const registry = await registryOf(commandControl);
    expect(done.stdout).toBe(`${ORGANIZATION_ID} ${registry.id} 6\n`);
    const shifted = open(String(registry.database_url));
    const controlTables = seededTables('control');
    const moved = sixDaysLater(await dump(control.$client, controlTables));
    expect(await dump(commandControl, controlTables)).toEqual(moved);
    const workspaceTables = seededTables('workspace');
    const movedWorkspace = sixDaysLater(await dump(workspace, workspaceTables));
    expect(await dump(shifted, workspaceTables)).toEqual(movedWorkspace);

    // A second run is refused and changes nothing; a remote control database is refused first.
    const before = [await snapshot(commandControl), await snapshot(shifted)];
    const refused = run(`file:./${file}`, '--date', '2026-09-20');
    expect([refused.status, refused.stdout]).toEqual([1, '']);
    expect([await snapshot(commandControl), await snapshot(shifted)]).toEqual(before);
    const remote = run('http://127.0.0.1:9');
    expect([remote.status, remote.stdout]).toEqual([2, '']);
    const output = [done, refused, remote].map(({ stdout, stderr }) => stdout + stderr);
    expect(output.join('')).not.toContain(PASSWORD);
  });
});
