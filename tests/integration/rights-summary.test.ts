import { readFileSync, rmSync } from 'node:fs';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '../../src/lib/auth/permissions';
import type { RightsHolderDTO } from '../../src/lib/dto/rights';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { northstarWarnings } from './catalog-support';
import { openWithoutForeignKeys } from './support';

type Connections = typeof import('../../src/server/services/workspace-connections');

const DATA_DIR = 'data/test-rights-summary';
const { keys } = JSON.parse(readFileSync('docs/fixtures/northstar-demo.json', 'utf8'));
const K = (id: string) => Object.keys(keys).find((key) => keys[key] === id);
const getWorkspaceDatabase = vi.fn<Connections['getWorkspaceDatabase']>();
let control: Awaited<ReturnType<typeof openWithoutForeignKeys>>;
let connections: Connections;
let rights: typeof import('../../src/server/services/rights/read');
let northstar: TenantContext;

const read = (entityType: 'composition' | 'recording', entityId: string, tenant = northstar) =>
  rights.getRightsSummary(tenant, { entityType, entityId });
async function summary(entityType: 'composition' | 'recording', entityId: string) {
  const result = await read(entityType, entityId);
  if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
  return result.value;
}

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
  rights = await import('../../src/server/services/rights/read');
  const { seedNorthstar } = await import('../../src/server/db/seed/northstar');
  const seeded = await seedNorthstar({ password: 'rights-password', seedDate: '2026-09-14' });
  expect(seeded).toMatchObject({ status: 'seeded', dateShift: 0 });
  const ids = seeded as Extract<typeof seeded, { status: 'seeded' }>;
  const tenant = { userId: keys.usr_JORDAN, workspaceRole: 'owner', requestId: 'rights' } as const;
  northstar = { ...tenant, organizationId: ids.organizationId, workspaceId: ids.workspaceId };
});

afterAll(async () => {
  if (northstar) await connections.closeWorkspaceDatabase(northstar.workspaceId);
  control?.$client.close();
});

describe('melos-rpr.7: RightsService reads a song rights summary (RGT-001 to RGT-004)', () => {
  it('totals Ocean Blue WORLD publishing at 8500 and Neon Static master at 7500 (EXPECTED.md §1)', async () => {
    const sets = (list: { totalBp: number; holders: RightsHolderDTO[] }[]) =>
      list.map(({ totalBp, holders }) => [
        totalBp,
        ...holders.map((h) => `${K(h.partyId)} ${h.shareBp}${h.isSelf ? ' self' : ''}`),
      ]);
    const ocean = await summary('composition', keys.cmp_OCEAN);
    expect(ocean.publishing.map(({ territory }) => territory)).toEqual(['WORLD']);
    const oceanPublishers = [8500, 'pty_NIGHTSHIFT 2500', 'pty_SILVERLINE 6000 self'];
    expect(sets(ocean.publishing)).toEqual([oceanPublishers]);
    const neon = await summary('recording', keys.rec_NEON);
    expect(sets(neon.masters)).toEqual([[7500, 'pty_NIGHTSHIFT 7500']]);
    const writers = neon.writers.map((w) => `${K(w.partyId)} ${w.shareBp} ${w.roles}`);
    const expected = [10000, 'pty_ALEX 5000 songwriter', 'pty_JORDAN 5000 songwriter'];
    expect([neon.writerTotalBp, ...writers]).toEqual(expected);
  });

  it('gives Midnight Drive Silverline Songs as implicit contact, by composition or recording (P-28)', async () => {
    const silverline = { partyId: keys.pty_SILVERLINE, displayName: 'Silverline Songs' };
    const holder = (key: string) => ({
      ...{ interestId: keys[key], ...silverline, shareBp: 10000, isSelf: true },
      ...{ representationAttested: false, agreementId: null },
    });
    const writer = { contributorId: keys.ctr_MIDNIGHT_JORDAN, partyId: keys.pty_JORDAN };
    const publishing = holder('publishing_interests:MIDNIGHT_SILVERLINE_WORLD');
    const midnight = await summary('recording', keys.rec_MIDNIGHT);
    expect(midnight).toEqual({
      compositionId: keys.cmp_MIDNIGHT,
      writers: [{ ...writer, displayName: 'Jordan Taylor', roles: ['songwriter'], shareBp: 10000 }],
      writerTotalBp: 10000,
      publishing: [{ territory: 'WORLD', totalBp: 10000, holders: [publishing] }],
      masters: [
        {
          ...{ recordingId: keys.rec_MIDNIGHT, totalBp: 10000 },
          holders: [holder('master_interests:MIDNIGHT_SILVERLINE')],
        },
      ],
      licensingContacts: [{ ...silverline, implicit: true }],
      issues: northstarWarnings(keys.rec_MIDNIGHT, keys.cmp_MIDNIGHT),
    });
    expect(await summary('composition', keys.cmp_MIDNIGHT)).toEqual(midnight);
  });

  it('answers NOT_FOUND for an unknown id, and FORBIDDEN to owner,viewer without opening the database', async () => {
    const notFound = { ok: false, error: { code: 'NOT_FOUND' } };
    expect(await read('composition', 'cmp_UNKNOWN')).toEqual(notFound);
    expect(await read('recording', keys.cmp_OCEAN)).toEqual(notFound);
    getWorkspaceDatabase.mockClear();
    const viewer = { ...northstar, workspaceRole: 'viewer' } as const;
    expect(await read('composition', keys.cmp_OCEAN, viewer)).toMatchObject({ ok: true });
    // Probe: the read asks for the database through the recorded function.
    expect(getWorkspaceDatabase).toHaveBeenCalledTimes(1);
    getWorkspaceDatabase.mockClear();
    const refused = { ...northstar, workspaceRole: 'owner,viewer' as WorkspaceRole };
    const forbidden = { ok: false, error: { code: 'FORBIDDEN' } };
    expect(await read('recording', keys.rec_OCEAN, refused)).toEqual(forbidden);
    expect(getWorkspaceDatabase).not.toHaveBeenCalled();
  });

  it('reads each call in one libSQL batch, one round trip to the workspace database (§1.4)', async () => {
    const { $client } = await connections.getWorkspaceDatabase(northstar.workspaceId);
    const spies = (['batch', 'execute', 'transaction'] as const).map((m) => vi.spyOn($client, m));
    try {
      await summary('composition', keys.cmp_OCEAN);
      await summary('recording', keys.rec_NEON);
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([2, 0, 0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
