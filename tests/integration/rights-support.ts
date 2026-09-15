import { readFileSync, rmSync } from 'node:fs';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { ulid } from 'ulid';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import type { WorkspaceRole } from '../../src/lib/auth/permissions';
import { organization } from '../../src/server/db/schema/auth';
import * as ws from '../../src/server/db/schema/workspace.generated';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { openWithoutForeignKeys } from './support';

type Connections = typeof import('../../src/server/services/workspace-connections');

export const AT = '2026-09-14T17:00:00.000Z';
export const { keys } = JSON.parse(readFileSync('docs/fixtures/northstar-demo.json', 'utf8'));
/** The northstar-demo.json key of an id. */
export const K = (id: string) => Object.keys(keys).find((key) => keys[key] === id);
const md = readFileSync('docs/fixtures/EXPECTED.md', 'utf8').replace(/\r|`/g, '');
/** The body rows of the EXPECTED.md table marked `check:<name>`, as cells. */
export const table = (name: string) =>
  md
    .split(`<!-- check:${name} -->\n`)[1]
    .split('\n\n')[0]
    .split('\n')
    .slice(2)
    .map((line) => line.split(/\s*\|\s*/).slice(1, -1));
/**
 * Second workspace rows, self party S: song C1 has an S and an O master, C2 two S and a deleted O,
 * C3 no recording; RX belongs to the deleted composition CX, and LONE to no composition.
 */
const NAMES = ['S', 'O', 'C1', 'C2', 'C3', 'CX', 'R1', 'R2', 'R3', 'R4', 'RX', 'GONE', 'LONE'];
export const ID = Object.fromEntries(NAMES.map((n) => [n, `${n}_${ulid()}`]));
export const refused = (code: 'FORBIDDEN' | 'NOT_FOUND') => ({ ok: false, error: { code } });
/** Records every request for a workspace database. */
export const getWorkspaceDatabase = vi.fn<Connections['getWorkspaceDatabase']>();

/** A role TenantContextResolver refuses can still reach a service called another way. */
export const withRole = (tenant: TenantContext, role: string) => ({
  ...tenant,
  workspaceRole: role as WorkspaceRole,
});
export function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
  return result.value;
}

/**
 * Seeds Northstar for 2026-09-14 and a second workspace holding the ID rows, under `dataDir`, with
 * an in-memory control database. The returned object is filled before the file's own hooks run.
 */
export function rightsWorkspaces(dataDir: string) {
  const env = {} as { connections: Connections; northstar: TenantContext; other: TenantContext };
  let control: Awaited<ReturnType<typeof openWithoutForeignKeys>>;
  beforeAll(async () => {
    rmSync(dataDir, { recursive: true, force: true });
    process.env.MELOS_WORKSPACE_DATA_DIR = `${dataDir}/workspaces`;
    const migrationsFolder = './src/server/db/migrations/control';
    control = await openWithoutForeignKeys((db) => migrate(db, { migrationsFolder }));
    const controlClient = { controlDb: control, controlDatabaseClient: control.$client };
    vi.doMock('../../src/server/db/client', () => controlClient);
    vi.doMock('../../src/server/services/workspace-connections', async (importOriginal) => {
      const original = await importOriginal<Connections>();
      getWorkspaceDatabase.mockImplementation(original.getWorkspaceDatabase);
      return { ...original, getWorkspaceDatabase };
    });
    env.connections = await import('../../src/server/services/workspace-connections');
    const { seedNorthstar } = await import('../../src/server/db/seed/northstar');
    const { provisionWorkspace } = await import('../../src/server/services/workspace-provisioner');

    const seeded = await seedNorthstar({ password: 'rights-password', seedDate: '2026-09-14' });
    expect(seeded).toMatchObject({ status: 'seeded', dateShift: 0 });
    const { organizationId, workspaceId } = seeded as Extract<typeof seeded, { status: 'seeded' }>;
    const tenant = {
      userId: keys.usr_JORDAN,
      workspaceRole: 'owner',
      requestId: 'rights',
    } as const;
    env.northstar = { ...tenant, organizationId, workspaceId };
    const created = { id: `organization_${ulid()}`, name: 'Other', slug: 'other' };
    await control.insert(organization).values({ ...created, createdAt: new Date() });
    const registry = await provisionWorkspace(created.id);
    env.other = { ...tenant, organizationId: created.id, workspaceId: registry.id };

    const database = await env.connections.getWorkspaceDatabase(registry.id);
    const row = <T extends object>(id: string, values: T) => ({ id, ...values, ...stamps });
    const stamps = { createdAt: AT, updatedAt: AT };
    const take = (id: string, compositionId: string | null, deletedAt: string | null = null) =>
      row(id, { title: id, compositionId, deletedAt });
    const master = (recordingId: string, ownerPartyId: string) =>
      row(ulid(), { recordingId, ownerPartyId, shareBp: 10000 });
    const self = (side: string) => ({
      side,
      partyId: ID.S,
      partyKind: 'organization',
      updatedAt: AT,
    });
    const party = (name: string) => row(ID[name], { partyKind: 'organization', displayName: name });
    const publisher = (compositionId: string) =>
      row(ulid(), { compositionId, publisherPartyId: ID.S, shareBp: 10000 });
    await database.batch([
      database.insert(ws.parties).values([party('S'), party('O')]),
      database.insert(ws.workspaceSelfParties).values([self('publishing'), self('master')]),
      database
        .insert(ws.compositions)
        .values([
          ...[row(ID.C1, { title: 'C1' }), row(ID.C2, { title: 'C2' })],
          ...[row(ID.C3, { title: 'C3' }), row(ID.CX, { title: 'CX', deletedAt: AT })],
        ]),
      database
        .insert(ws.recordings)
        .values([
          ...[take(ID.R1, ID.C1), take(ID.R2, ID.C1), take(ID.R3, ID.C2), take(ID.R4, ID.C2)],
          ...[take(ID.GONE, ID.C2, AT), take(ID.LONE, null), take(ID.RX, ID.CX)],
        ]),
      database.insert(ws.publishingInterests).values([publisher(ID.C1), publisher(ID.C2)]),
      database
        .insert(ws.masterInterests)
        .values([
          ...[master(ID.R1, ID.S), master(ID.R2, ID.O), master(ID.R3, ID.S)],
          ...[master(ID.R4, ID.S), master(ID.GONE, ID.O), master(ID.LONE, ID.S)],
        ]),
    ]);
  });
  afterAll(async () => {
    for (const tenant of [env.northstar, env.other]) {
      if (tenant) await env.connections.closeWorkspaceDatabase(tenant.workspaceId);
    }
    control?.$client.close();
  });
  return env;
}
