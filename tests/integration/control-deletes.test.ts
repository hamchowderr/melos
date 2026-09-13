import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  controlAuditLog,
  migrationRuns,
  workspaceMemberSettings,
  workspaceRegistry,
} from '../../src/server/db/schema/control';
import { IntegrityError } from '../../src/server/services/integrity-guard';
import { expectForeignKeysIntact, openWithoutForeignKeys, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;
type Person = { client: TestClient; userId: string };
type Guard = typeof import('../../src/server/services/integrity-guard').controlIntegrityGuard;
type Hosts = typeof import('../../src/server/db/workspace-hosts');
type Workspace = typeof workspaceRegistry.$inferSelect;

const DATA_DIR = 'data/test-control-deletes-workspaces';
const TOKEN = 'workspace-jwt-that-must-never-be-stored';
const iso = new Date().toISOString();
let control: Awaited<ReturnType<typeof openWithoutForeignKeys>>;
let authRoute: { POST: Handler };
let copilotRoute: { GET: Handler };
let auth: typeof import('../../src/server/auth/auth').auth;
let guard: Guard;
let checkedDelete: Guard['delete'];
let hosts: Hosts;
const createHost = vi.fn<Hosts['createWorkspaceHost']>();

/**
 * The real host, except that provisioning migrates a memory database instead of the file `create`
 * makes: Windows keeps a file libSQL opened locked until garbage collection, and the delete removes it.
 */
const unopened: Hosts['createWorkspaceHost'] = (setting, fetchApi) => {
  const host = hosts.createWorkspaceHost(setting, fetchApi);
  const create = async (name: string) => ({ ...(await host.create(name)), url: ':memory:' });
  return { ...host, create };
};

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.env.MELOS_WORKSPACE_DATA_DIR = DATA_DIR;
  const migrationsFolder = './src/server/db/migrations/control';
  control = await openWithoutForeignKeys((db) => migrate(db, { migrationsFolder }));
  // The app's file client pools connections, and a pragma holds only where it was set. This client
  // has one in-memory connection, so Better Auth, the hooks and their transactions all run with
  // enforcement off and only IntegrityGuard keeps melos-control consistent.
  vi.doMock('../../src/server/db/client', () => ({
    controlDb: control,
    controlDatabaseClient: control.$client,
  }));
  vi.doMock('../../src/server/db/workspace-hosts', async (importOriginal) => {
    hosts = await importOriginal<Hosts>();
    return { ...hosts, createWorkspaceHost: createHost.mockImplementation(unopened) };
  });
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  copilotRoute = await import('../../src/app/api/copilotkit/[[...slug]]/route');
  ({ auth } = await import('../../src/server/auth/auth'));
  guard = (await import('../../src/server/services/integrity-guard')).controlIntegrityGuard;
  const remove = guard.delete;
  checkedDelete = async (tx, table, where) => {
    expect(await tx.all(sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 0 }]);
    return remove(tx, table, where);
  };
  vi.spyOn(guard, 'delete').mockImplementation(checkedDelete);
});

afterAll(() => control?.$client.close());

const post = (client: TestClient, path: string, body: object) =>
  client.call(authRoute.POST, 'POST', `/api/auth${path}`, body);

async function signIn(name: string): Promise<Person> {
  const client = new TestClient();
  const credentials = { email: `${name}@example.test`, password: 'integration-password-123' };
  const signedUp = await post(client, '/sign-up/email', { ...credentials, name });
  const { user } = (await signedUp.json()) as { user: { id: string } };
  expect((await post(client, '/sign-in/email', credentials)).status).toBe(200);
  return { client, userId: user.id };
}

/** A workspace with `members`, active for all of them, a pending invitation and member settings. */
async function createWorkspace(slug: string, owner: Person, members: Person[] = []) {
  const created = await post(owner.client, '/organization/create', { name: slug, slug });
  const { id } = (await created.json()) as { id: string };
  for (const { userId } of members) {
    await auth.api.addMember({ body: { userId, organizationId: id, role: 'member' } });
  }
  for (const { client } of [owner, ...members]) {
    expect((await post(client, '/organization/set-active', { organizationId: id })).status).toBe(
      200,
    );
  }
  const body = {
    email: `invited-${slug}@example.test`,
    role: 'member' as const,
    organizationId: id,
  };
  await auth.api.createInvitation({ headers: owner.client.headers(), body });
  const settings = [owner, ...members].map(({ userId }) => ({ organizationId: id, userId }));
  const rows = settings.map((row) => ({ ...row, updatedAt: iso }));
  await expectForeignKeysIntact(control, (tx) => guard.insert(tx, workspaceMemberSettings, rows));
  return id;
}

/** Adds a migration run to the workspace that creating the organization provisioned (§7.2). */
async function register(organizationId: string) {
  const provisioned = eq(workspaceRegistry.organizationId, organizationId);
  const [{ id: workspaceId }] = await control.select().from(workspaceRegistry).where(provisioned);
  const run = { id: `mig_${organizationId}`, batchId: 'b1', workspaceId, fromVersion: 0 };
  await expectForeignKeysIntact(control, (tx) =>
    guard.insert(tx, migrationRuns, [{ ...run, toVersion: 1, status: 'succeeded' }]),
  );
}

async function workspaceOf(organizationId: string) {
  const byOrganization = eq(workspaceRegistry.organizationId, organizationId);
  return (await control.select().from(workspaceRegistry).where(byOrganization))[0];
}

/** The file the local host created for the workspace (`unopened` stores `:memory:` as its URL). */
const fileOf = ({ databaseName }: Workspace) => `${DATA_DIR}/${databaseName}.db`;

/** One `workspace.deleted` row holding the registry row as deleted, without its token column. */
async function expectDeletedAudit(workspace: Workspace, actorUserId: string) {
  const { id, organizationId, databaseName } = workspace;
  const action = eq(controlAuditLog.action, 'workspace.deleted');
  const audit = await control
    .select()
    .from(controlAuditLog)
    .where(and(eq(controlAuditLog.targetId, id), action));
  const event = { actorUserId, organizationId, targetType: 'workspace', afterJson: null };
  expect(audit).toMatchObject([event]);
  const row = JSON.parse(String(audit[0].beforeJson));
  const named = { id, organization_id: organizationId, database_name: databaseName };
  expect(row).toMatchObject({ ...named, status: 'deleting' });
  expect(row).not.toHaveProperty('db_token_ciphertext');
}

async function countRows(conditions: Record<string, SQL>) {
  const counts: Record<string, number> = {};
  for (const [table, where] of Object.entries(conditions)) {
    const query = sql`SELECT count(*) AS n FROM ${sql.identifier(table)} WHERE ${where}`;
    [{ n: counts[table] }] = await control.all<{ n: number }>(query);
  }
  return counts;
}

const referencing = (id: string) =>
  countRows({
    organization: sql`id = ${id}`,
    member: sql`organization_id = ${id}`,
    invitation: sql`organization_id = ${id}`,
    workspace_member_settings: sql`organization_id = ${id}`,
    workspace_registry: sql`organization_id = ${id}`,
    migration_runs: sql`id = ${`mig_${id}`}`,
    session: sql`active_organization_id = ${id}`,
    control_audit_log: sql`organization_id = ${id}`,
  });

const belongingTo = (id: string) =>
  countRows({
    user: sql`id = ${id}`,
    session: sql`user_id = ${id}`,
    account: sql`user_id = ${id}`,
    member: sql`user_id = ${id}`,
    invitation: sql`inviter_id = ${id}`,
    workspace_member_settings: sql`user_id = ${id}`,
    control_audit_log: sql`actor_user_id = ${id}`,
  });

const none = (counts: Record<string, number>) =>
  Object.fromEntries(Object.keys(counts).map((table) => [table, 0]));

/** DAT-INT-001 around a Better Auth call, which needs the connection a test transaction would hold. */
async function expectIntactAfter<T>(operation: () => Promise<T>): Promise<T> {
  expect(await control.all(sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 0 }]);
  try {
    return await operation();
  } finally {
    expect(await control.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  }
}

const deleteWorkspace = ({ client }: Person, organizationId: string) =>
  expectIntactAfter(() => post(client, '/organization/delete', { organizationId }));

describe('DAT-INT-001: Better Auth organization and user deletes with foreign keys off', () => {
  let owner: Person;
  let teammate: Person;

  it('deletes an organization, its workspace database and every row referencing it, keeping its audit rows', async () => {
    owner = await signIn('owner');
    teammate = await signIn('teammate');
    const doomed = await createWorkspace('doomed', owner, [teammate]);
    await register(doomed);
    const workspace = await workspaceOf(doomed);
    expect(existsSync(fileOf(workspace))).toBe(true);
    const rows = { organization: 1, member: 2, invitation: 1, workspace_member_settings: 2 };
    const more = { workspace_registry: 1, migration_runs: 1, session: 2 };
    // Two member.added, member.invited and workspace.provisioned.
    expect(await referencing(doomed)).toEqual({ ...rows, ...more, control_audit_log: 4 });

    expect((await deleteWorkspace(owner, doomed)).status).toBe(200);
    // Plus workspace.deleted.
    const left = { ...none({ ...rows, ...more }), control_audit_log: 5 };
    expect(await referencing(doomed)).toEqual(left);
    expect(existsSync(fileOf(workspace))).toBe(false);
    await expectDeletedAudit(workspace, owner.userId);
  });

  it('answers 403 to the next request of a session whose active organization was deleted', async () => {
    const response = await teammate.client.call(copilotRoute.GET, 'GET', '/api/copilotkit/info');
    const refusal = [403, { error: 'no-active-workspace' }];
    expect([response.status, await response.json()]).toEqual(refusal);
  });

  it('deletes a user with its sessions, accounts, memberships, sent invitations and settings', async () => {
    const leaving = await signIn('leaving');
    await createWorkspace('shared', owner, [leaving]);
    await createWorkspace('leaving-own', leaving);
    const owners = await belongingTo(owner.userId);
    const rows = { user: 1, session: 1, account: 1, member: 2, invitation: 1 };
    expect(await belongingTo(leaving.userId)).toEqual({
      ...rows,
      workspace_member_settings: 2,
      // member.added, member.invited and workspace.provisioned for leaving-own.
      control_audit_log: 3,
    });

    // /delete-user, its callback and any admin removal all delete through this adapter call.
    const { internalAdapter } = await auth.$context;
    await expectIntactAfter(() => internalAdapter.deleteUser(leaving.userId));
    // Audit rows keep the actor id of a deleted user (§4.1).
    const left = { ...none({ ...rows, workspace_member_settings: 2 }), control_audit_log: 3 };
    expect(await belongingTo(leaving.userId)).toEqual(left);
    expect(await belongingTo(owner.userId)).toEqual(owners);
  });

  it('keeps every row when Better Auth or IntegrityGuard refuses an organization delete', async () => {
    const kept = await createWorkspace('kept', owner, [teammate]);
    await register(kept);
    const before = await referencing(kept);
    // A member lacks organization:delete, so Better Auth refuses before calling the hook.
    expect((await deleteWorkspace(teammate, kept)).status).toBe(403);
    expect(await referencing(kept)).toEqual(before);
    expect(await workspaceOf(kept)).toMatchObject({ status: 'active' });

    // A refusal after the registry row is deleted rolls the hook's transaction back.
    const refusal = new IntegrityError('REFERENCED', 'organization', { workspace_registry: 1 });
    vi.mocked(guard.delete).mockImplementationOnce(checkedDelete).mockRejectedValueOnce(refusal);
    const refused = await deleteWorkspace(owner, kept);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'REFERENCED' });
    // Better Auth clears the caller's active organization before it calls the hook (ADR-030).
    expect(await referencing(kept)).toEqual({ ...before, session: before.session - 1 });
    // The database went before the transaction, so the row stays deleting for a retry (§7.2).
    expect(await workspaceOf(kept)).toMatchObject({ status: 'deleting', statusDetail: null });
  });

  it('keeps the organization and a deleting row without a token when the host delete fails; deleting again completes', async () => {
    const unlucky = await createWorkspace('unlucky', owner);
    const workspace = await workspaceOf(unlucky);
    const local = hosts.createWorkspaceHost({ kind: 'local', dataDir: DATA_DIR });
    createHost.mockReturnValueOnce({ ...local, delete: () => Promise.reject(new Error(TOKEN)) });
    // The database exists, so an unconfigured host refuses too.
    const missing = ['TURSO_API_TOKEN'];
    createHost.mockReturnValueOnce(hosts.createWorkspaceHost({ kind: 'unconfigured', missing }));
    for (const error of ['Error', 'WorkspaceHostConfigError']) {
      const failed = await deleteWorkspace(owner, unlucky);
      const body = await failed.text();
      expect([failed.status, JSON.parse(body).code]).toEqual([503, 'WORKSPACE_DELETE_FAILED']);
      const row = await workspaceOf(unlucky);
      const detail = `delete_database failed: ${error}`;
      expect(row).toMatchObject({ status: 'deleting', statusDetail: detail });
      expect(JSON.stringify([row, body])).not.toContain(TOKEN);
      const still = { organization: 1, member: 1, workspace_registry: 1 };
      expect(await referencing(unlucky)).toMatchObject(still);
    }
    expect(existsSync(fileOf(workspace))).toBe(true);

    expect((await deleteWorkspace(owner, unlucky)).status).toBe(200);
    expect(await referencing(unlucky)).toMatchObject({ organization: 0, workspace_registry: 0 });
    expect(existsSync(fileOf(workspace))).toBe(false);
    await expectDeletedAudit(workspace, owner.userId);
  });

  it('deletes an organization whose workspace never got a database while the host is unconfigured (production today)', async () => {
    const unconfigured = () =>
      hosts.createWorkspaceHost({ kind: 'unconfigured', missing: ['TURSO_ORG'] });
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    createHost.mockReturnValueOnce(unconfigured());
    const never = await createWorkspace('never-created', owner);
    const workspace = await workspaceOf(never);
    const detail = 'create_database failed: WorkspaceHostConfigError';
    expect(workspace).toMatchObject({ status: 'failed', statusDetail: detail, databaseUrl: '' });

    // Only a host's create sets database_url, so there is no database to delete.
    createHost.mockReturnValueOnce(unconfigured());
    expect((await deleteWorkspace(owner, never)).status).toBe(200);
    expect(await referencing(never)).toMatchObject({ organization: 0, workspace_registry: 0 });
    await expectDeletedAudit(workspace, owner.userId);
  });

  it('names the workspace database in the Turso Platform API delete call', async () => {
    const hosted = await createWorkspace('hosted', owner);
    const name = (await workspaceOf(hosted)).databaseName.toLowerCase();
    const calls: string[] = [];
    const turso = { apiToken: 'platform-api-token', organization: 'example-org', group: 'default' };
    const setting = {
      kind: 'turso',
      ...turso,
      tokenKey: randomBytes(32).toString('base64'),
    } as const;
    const host = hosts.createWorkspaceHost(setting, async (url, init) => {
      calls.push(`${init.method} ${url}`);
      return Response.json({ database: name });
    });
    createHost.mockReturnValueOnce(host);
    expect((await deleteWorkspace(owner, hosted)).status).toBe(200);
    const databases = 'https://api.turso.tech/v1/organizations/example-org/databases';
    expect(calls).toEqual([`DELETE ${databases}/${name}`]);
    expect(await workspaceOf(hosted)).toBeUndefined();
  });
});
