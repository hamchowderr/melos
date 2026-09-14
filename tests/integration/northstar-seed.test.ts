import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Client, createClient, type InValue } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateSeeded } from '../../docs/fixtures/validate.mjs';
import { openWithoutForeignKeys, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;
type Tables = Record<string, Record<string, unknown>[]>;
type Seed = typeof import('../../src/server/db/seed/northstar');
type Command = typeof import('../../scripts/seed-demo');
type ValidateCommand = typeof import('../../scripts/validate-demo');

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
let runValidateDemoCommand: ValidateCommand['runValidateDemoCommand'];
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

/** Runs an npm script's tsx command in a child process, as npm run does, with the demo password. */
function runScript(name: string, variables: Record<string, string>, ...flags: string[]) {
  const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts[name];
  const [runner, ...args] = String(script).split(' ');
  expect(runner).toBe('tsx');
  const env = { ...process.env, VERCEL: '', MELOS_DEMO_PASSWORD: PASSWORD, ...variables };
  const tsx = ['node_modules/tsx/dist/cli.mjs', ...args, ...flags];
  return spawnSync(process.execPath, tsx, { env, encoding: 'utf8', timeout: 50_000 });
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
  ({ runValidateDemoCommand } = await import('../../scripts/validate-demo'));
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
    const run = (url: string, ...flags: string[]) => {
      const workspaces = `${DATA_DIR}/command-workspaces`;
      const variables = { MELOS_CONTROL_DATABASE_URL: url, MELOS_WORKSPACE_DATA_DIR: workspaces };
      return runScript('db:seed-demo', variables, ...flags);
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

// Runs after the seed tests, which compare seeded rows: the share case edits the seeded workspace.
describe('melos-cqn.2: a seeded Northstar workspace meets every demo precondition (§5.6, §6.5)', () => {
  const lines: string[] = [];
  const validate = () => runValidateDemoCommand([], (line) => lines.push(line));

  it('db:validate-demo passes the full validate.mjs assertion set against the seed for 2026-09-14', async () => {
    const script = spawnSync(process.execPath, ['docs/fixtures/validate.mjs'], {
      encoding: 'utf8',
      timeout: 50_000,
    });
    const [, total] = /^(\d+) assertions, 0 failed\n$/.exec(script.stdout) ?? [];
    expect([script.status, total], script.stderr).toEqual([0, expect.stringMatching(/^\d+$/)]);
    expect(await validate()).toBe(0);
    expect(lines).toEqual([`${total} assertions, 0 failed`]);
  });

  it('passes when the control database also holds another organization, its member and workspace', async () => {
    // Fixture rows under new ids, in parent order: no Northstar check may count them.
    type Row = Record<string, InValue>;
    const organizationId = 'organization_OTHER';
    const like = (table: string, values: Row): Row => ({ ...fixture.control[table][0], ...values });
    const owner = { user_id: 'usr_OTHER', organization_id: organizationId };
    const database = { organization_id: organizationId, database_name: 'melos-ws-OTHER' };
    const others: [string, Row][] = [
      ['user', like('user', { id: 'usr_OTHER', email: 'other@other.example' })],
      ['organization', like('organization', { id: organizationId, slug: 'other' })],
      ['member', like('member', { id: 'member_OTHER', ...owner })],
      ['workspace_registry', like('workspace_registry', { id: 'ws_OTHER', ...database })],
    ];
    const insert = ([table, row]: [string, Row]) => {
      const columns = Object.keys(row).map((column) => `"${column}"`);
      const sql = `INSERT INTO "${table}" (${columns}) VALUES (${columns.map(() => '?')})`;
      return { sql, args: Object.values(row) };
    };
    await control.$client.batch(others.map(insert), 'write');
    lines.length = 0;
    try {
      expect(await validate(), lines.join('\n')).toBe(0);
    } finally {
      const remove = ([table, { id }]: [string, Row]) => ({
        sql: `DELETE FROM "${table}" WHERE id = ?`,
        args: [id],
      });
      await control.$client.batch([...others].reverse().map(remove), 'write');
    }
  });

  it('fails the seeded run with the check name when a pitch event is deleted or a share changes', async () => {
    // pitch_events is append-only, so the delete runs on a copy without its delete trigger.
    const copy = `${DATA_DIR}/pitch-event-deleted.db`;
    await workspace.execute(`VACUUM INTO '${copy}'`);
    const deleted = open(`file:./${copy}`);
    await deleted.execute('DROP TRIGGER pitch_events_no_delete');
    const event =
      "DELETE FROM pitch_events WHERE pitch_item_id = ? AND to_status = 'awaiting_reply'";
    const removed = await deleted.execute({ sql: event, args: [keys.pti_PAPER_REBECCA] });
    expect(removed.rowsAffected).toBe(1);
    const { failures } = await validateSeeded(control.$client, deleted);
    const status = 'pti_PAPER_REBECCA current_status is the latest status event';
    expect(failures).toContainEqual(
      expect.objectContaining({ group: 'projections', label: status }),
    );

    const share = 'UPDATE composition_contributors SET writer_share_bp = ? WHERE id = ?';
    await workspace.execute({ sql: share, args: [4000, keys.ctr_OCEAN_ALEX] });
    lines.length = 0;
    try {
      expect(await validate()).toBe(1);
    } finally {
      await workspace.execute({ sql: share, args: [5000, keys.ctr_OCEAN_ALEX] });
    }
    expect(lines).toContainEqual(
      expect.stringMatching(/^FAIL \[contract\] §6\.5 Ocean Blue totals\n/),
    );
    expect(lines.at(-1)).toMatch(/^\d+ assertions, [1-9]\d* failed$/);
  });
});

// Child processes only: Windows keeps a libSQL file this process opened locked until garbage
// collection, and replacing deletes the earlier workspace file.
describe('melos-cqn.3: db:seed-demo -- --replace replaces an earlier seed, complete or partial (§8 phase 3)', () => {
  const file = `${DATA_DIR}/replace-control.db`;
  const workspaces = `${DATA_DIR}/replace-workspaces`;
  const variables = {
    MELOS_CONTROL_DATABASE_URL: `file:./${file}`,
    MELOS_WORKSPACE_DATA_DIR: workspaces,
  };
  const seed = (...flags: string[]) =>
    runScript('db:seed-demo', variables, '--date', '2026-09-14', ...flags);
  const replace = () => seed('--replace');
  let replaceControl: Client;
  let previous: Record<string, unknown>;
  const fileOf = (registry: Record<string, unknown>) =>
    `${workspaces}/${registry.database_name}.db`;

  /** One Northstar organization, user, registry row and workspace file, seeded completely. */
  async function expectOneSeed(...runs: SpawnSyncReturns<string>[]) {
    for (const { status, stderr } of runs) expect(status, stderr).toBe(0);
    const identities =
      'SELECT (SELECT group_concat(id) FROM organization) AS o, group_concat(id) AS u FROM user';
    expect(await rows(replaceControl, identities)).toEqual([
      { o: ORGANIZATION_ID, u: keys.usr_JORDAN },
    ]);
    const registries = await rows(replaceControl, 'SELECT * FROM workspace_registry');
    expect(registries).toMatchObject([{ organization_id: ORGANIZATION_ID, status: 'active' }]);
    expect(readdirSync(workspaces)).toEqual([`${registries[0].database_name}.db`]);
    // The replace signed in as the seeded user and out again: no session is left.
    expect(await rows(replaceControl, 'SELECT count(*) AS n FROM session')).toEqual([{ n: 0 }]);
    const validated = runScript('db:validate-demo', variables);
    const passed = [0, expect.stringMatching(/^\d+ assertions, 0 failed\n$/)];
    expect([validated.status, validated.stdout], validated.stderr).toEqual(passed);
    const output = [...runs, validated].map(({ stdout, stderr }) => stdout + stderr);
    expect(output.join('')).not.toContain(PASSWORD);
    [previous] = registries;
  }

  beforeAll(async () => {
    replaceControl = open(`file:./${file}`);
    await migrate(drizzle(replaceControl), { migrationsFolder: MIGRATIONS });
  });

  it('replaces a complete seed: the earlier workspace database is deleted and the new seed passes db:validate-demo', async () => {
    await expectOneSeed(seed());
    const earlier = previous;
    await expectOneSeed(replace());
    expect(existsSync(fileOf(earlier))).toBe(false);
    const deleted = "SELECT target_id FROM control_audit_log WHERE action = 'workspace.deleted'";
    expect(await rows(replaceControl, deleted)).toEqual([{ target_id: earlier.id }]);
  });

  it('refuses a wrong password or a live provisioning claim with 1, deleting and seeding nothing', async () => {
    const claim = 'UPDATE workspace_registry SET status = ?, updated_at = ?';
    await replaceControl.execute({ sql: claim, args: ['provisioning', new Date().toISOString()] });
    const before = await snapshot(replaceControl);
    const wrong = runScript(
      'db:seed-demo',
      { ...variables, MELOS_DEMO_PASSWORD: 'not-the-seed-password' },
      '--replace',
    );
    const held = replace();
    const refused = `Organization ${ORGANIZATION_ID} was not replaced`;
    expect([wrong.status, wrong.stdout, wrong.stderr]).toEqual([
      1,
      '',
      expect.stringContaining(
        `${refused} (sign_in 401 INVALID_EMAIL_OR_PASSWORD); nothing was seeded`,
      ),
    ]);
    expect([held.status, held.stdout]).toEqual([1, '']);
    expect(held.stderr).toContain('at provisioning_in_progress: WorkspaceClaimHeld');
    expect(held.stderr).toContain(`${refused} (delete_organization 503 WORKSPACE_DELETE_FAILED)`);
    expect(await snapshot(replaceControl)).toEqual(before);
    expect(existsSync(fileOf(previous))).toBe(true);
    expect(held.stdout + held.stderr + wrong.stderr).not.toContain(PASSWORD);
    await replaceControl.execute({ sql: claim, args: ['active', new Date().toISOString()] });
  });

  it('replaces a partial seed whose registry row is failed over a database with no tables', async () => {
    const failed =
      "UPDATE workspace_registry SET status = 'failed', status_detail = 'migrate failed: Error'";
    await replaceControl.execute(failed);
    writeFileSync(fileOf(previous), '');
    await expectOneSeed(replace());
  });

  it('replaces a partial seed with no registry row, and a seeded user with no organization', async () => {
    // A seed that stopped after its control commit, before provisioning registered the workspace.
    rmSync(fileOf(previous));
    await replaceControl.execute('DELETE FROM workspace_registry');
    await expectOneSeed(replace());
    // A replace that deleted the organization and stopped before deleting the user.
    rmSync(fileOf(previous));
    const tables = ['workspace_registry', 'workspace_member_settings', 'member', 'organization'];
    await replaceControl.batch(
      tables.map((table) => `DELETE FROM "${table}"`),
      'write',
    );
    await expectOneSeed(replace());
  });
});
