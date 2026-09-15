import { readFileSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '../../src/lib/auth/permissions';
import { organization } from '../../src/server/db/schema/auth';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { openWithoutForeignKeys } from './support';

type Connections = typeof import('../../src/server/services/workspace-connections');
type Contacts = typeof import('../../src/server/services/contacts/read');

const DATA_DIR = 'data/test-contacts-read';
const AT = '2026-09-14T17:00:00.000Z';
const fixture = JSON.parse(readFileSync('docs/fixtures/northstar-demo.json', 'utf8'));
const { keys } = fixture as { keys: Record<string, string> };
/** The second workspace's only party, Sam Rivera: a primary email and an older one that is not. */
const [SAM, EMAIL, OLD_EMAIL] = [`pty_${ulid()}`, ulid(), ulid()];
const FORBIDDEN = { ok: false, error: { code: 'FORBIDDEN' } };
const getWorkspaceDatabase = vi.fn<Connections['getWorkspaceDatabase']>();
let control: Awaited<ReturnType<typeof openWithoutForeignKeys>>;
let connections: Connections;
let contacts: Contacts;
let northstar: TenantContext;
let other: TenantContext;

/** A role TenantContextResolver refuses can still reach a service called another way. */
const withRole = (tenant: TenantContext, role: string) => ({
  ...tenant,
  workspaceRole: role as WorkspaceRole,
});
function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
  return result.value;
}
const list = async (tenant: TenantContext, options?: Parameters<Contacts['listParties']>[1]) =>
  accepted(await contacts.listParties(tenant, options));

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.env.MELOS_WORKSPACE_DATA_DIR = `${DATA_DIR}/workspaces`;
  // One in-memory control connection with foreign keys off, as in catalog-read.test.ts.
  const migrationsFolder = './src/server/db/migrations/control';
  control = await openWithoutForeignKeys((db) => migrate(db, { migrationsFolder }));
  const controlClient = { controlDb: control, controlDatabaseClient: control.$client };
  vi.doMock('../../src/server/db/client', () => controlClient);
  // Records every request for a workspace database.
  vi.doMock('../../src/server/services/workspace-connections', async (importOriginal) => {
    const original = await importOriginal<Connections>();
    getWorkspaceDatabase.mockImplementation(original.getWorkspaceDatabase);
    return { ...original, getWorkspaceDatabase };
  });
  connections = await import('../../src/server/services/workspace-connections');
  contacts = await import('../../src/server/services/contacts/read');
  const { seedNorthstar } = await import('../../src/server/db/seed/northstar');
  const { provisionWorkspace } = await import('../../src/server/services/workspace-provisioner');

  const seeded = await seedNorthstar({ password: 'contacts-password', seedDate: '2026-09-14' });
  expect(seeded).toMatchObject({ status: 'seeded', dateShift: 0 });
  const { organizationId, workspaceId } = seeded as Extract<typeof seeded, { status: 'seeded' }>;
  const tenant = { userId: keys.usr_JORDAN, workspaceRole: 'owner', requestId: 'people' } as const;
  northstar = { ...tenant, organizationId, workspaceId };

  const created = { id: `organization_${ulid()}`, name: 'Other', slug: 'other' };
  await control.insert(organization).values({ ...created, createdAt: new Date() });
  const registry = await provisionWorkspace(created.id);
  other = { ...tenant, organizationId: created.id, workspaceId: registry.id };
  const database = await connections.getWorkspaceDatabase(registry.id);
  const [partyId, createdAt, updatedAt] = [SAM, AT, AT];
  const email = (id: string, value: string, isPrimary: number, at = AT) => ({
    ...{ id, partyId, methodType: 'email', value, isPrimary, createdAt: at, updatedAt: at },
  });
  await database.batch([
    database
      .insert(tables.parties)
      .values({ id: SAM, partyKind: 'person', displayName: 'Sam Rivera', createdAt, updatedAt }),
    database.insert(tables.people).values({ partyId, legalName: 'Samuel Rivera' }),
    database
      .insert(tables.contactMethods)
      .values([
        email(OLD_EMAIL, 'sam.old@example.test', 0, '2026-09-01T17:00:00.000Z'),
        email(EMAIL, 'sam@example.test', 1),
      ]),
  ]);
});

afterAll(async () => {
  for (const tenant of [northstar, other]) {
    if (tenant) await connections.closeWorkspaceDatabase(tenant.workspaceId);
  }
  control?.$client.close();
});

describe('melos-rpr.6: ContactService reads people and organizations (§2.3 /people, D-5)', () => {
  const REBECCA = {
    ...{ partyId: keys.pty_REBECCA, partyKind: 'person', displayName: 'Rebecca Carter' },
    primaryEmail: 'rebecca@cartersync.example',
    contact: {
      ...{ contactId: keys.con_REBECCA, roles: ['licensing_agent'] },
      ...{ organizationPartyId: keys.pty_CARTER_SYNC, organizationName: 'Carter Sync Agency' },
    },
  };

  it('lists 7 people and 7 organizations by name; Rebecca Carter is a licensing agent at Carter Sync Agency', async () => {
    const people = await list(northstar, { kind: 'person' });
    expect(people.map(({ displayName }) => displayName)).toEqual([
      ...['Alex Ramirez', 'Jordan Taylor', 'Malik Johnson', 'Maya Chen'],
      ...['Rebecca Carter', 'Sophia Lee', 'Theo Grant'],
    ]);
    expect(people.find(({ partyId }) => partyId === keys.pty_REBECCA)).toEqual(REBECCA);
    expect(await list(northstar, { kind: 'organization' })).toHaveLength(7);
    // query keeps the names that contain it, ignoring case and surrounding spaces.
    const agency = { partyId: keys.pty_CARTER_SYNC, partyKind: 'organization', primaryEmail: null };
    expect(await list(northstar, { query: ' CARTER ' })).toEqual([
      { ...agency, displayName: 'Carter Sync Agency', contact: null },
      REBECCA,
    ]);
  });

  it('leaves a soft-deleted party out of the list', async () => {
    const { parties } = tables;
    const database = await connections.getWorkspaceDatabase(northstar.workspaceId);
    const setDeletedAt = (deletedAt: string | null) =>
      database.update(parties).set({ deletedAt }).where(eq(parties.id, keys.pty_SOPHIA));
    await setDeletedAt(AT);
    try {
      const people = await list(northstar, { kind: 'person' });
      expect(people.map(({ partyId }) => partyId)).not.toContain(keys.pty_SOPHIA);
      expect(people).toHaveLength(6);
    } finally {
      await setDeletedAt(null);
    }
    expect(await list(northstar)).toHaveLength(14);
  });

  it('lists only the tenant workspace parties, each with its primary email (TEN-001)', async () => {
    const sam = { partyId: SAM, partyKind: 'person', displayName: 'Sam Rivera', contact: null };
    expect(await list(other)).toEqual([{ ...sam, primaryEmail: 'sam@example.test' }]);
    expect((await list(northstar)).map(({ partyId }) => partyId)).not.toContain(SAM);
  });

  it('lets viewer, member and owner read and refuses owner,viewer with FORBIDDEN before opening the database (§6.2, P-30)', async () => {
    getWorkspaceDatabase.mockClear();
    for (const role of ['viewer', 'member', 'owner']) {
      expect(await list(withRole(northstar, role))).toHaveLength(14);
    }
    // Probe: each read asks for the database through the recorded function.
    expect(getWorkspaceDatabase).toHaveBeenCalledTimes(3);
    getWorkspaceDatabase.mockClear();
    const refused = withRole(northstar, 'owner,viewer');
    expect(await contacts.listParties(refused)).toEqual(FORBIDDEN);
    expect(getWorkspaceDatabase).not.toHaveBeenCalled();
  });

  it('reads each call in one libSQL batch, one round trip to the workspace database (§1.4)', async () => {
    const { $client } = await connections.getWorkspaceDatabase(northstar.workspaceId);
    const methods = ['batch', 'execute', 'transaction'] as const;
    const spies = methods.map((method) => vi.spyOn($client, method));
    try {
      await contacts.listParties(northstar, { kind: 'organization', query: 'north' });
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([1, 0, 0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
