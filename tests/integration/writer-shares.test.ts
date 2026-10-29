import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WriterShareInput } from '../../src/lib/dto/rights';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import type { WorkspaceTransaction } from '../../src/server/services/workspace-write';
import { catalogSearchOf, NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Shares = typeof import('../../src/server/services/rights/shares');

let services: Services;
let service: Shares;
let owner: TenantContext;
const { auditLog, compositionContributors: writers, compositionContributorRoles: roles } = tables;
const { cmp_OCEAN: OCEAN, pty_JORDAN: JORDAN, pty_ALEX: ALEX } = NORTHSTAR.keys;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });
const invalid = (reason: string) => refused({ code: 'VALIDATION', field: 'shares', reason });
const share = (partyId: string, shareBp: number | null): WriterShareInput => ({
  ...{ partyId, roles: ['songwriter'], shareBp },
});

beforeAll(async () => {
  services = await prepareWorkspaceServices('writer-shares');
  service = await import('../../src/server/services/rights/shares');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const oceanWriters = async () =>
  (await open(owner)).select().from(writers).where(eq(writers.compositionId, OCEAN));
const auditsOf = async () =>
  (await open(owner)).select().from(auditLog).where(eq(auditLog.entityId, OCEAN));
const hash = async () =>
  service.writerSharesHash((await open(owner)) as unknown as WorkspaceTransaction, OCEAN);

async function consistent() {
  const database = await open(owner);
  const search = await catalogSearchOf(database);
  expect(search.indexed).toEqual(search.derived);
  expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
}

describe('melos-rpr.21: updateWriterShares (RGT-001, RGT-004, DEMO-008)', () => {
  it('changes the DEMO-008 set in place, keeping ids, and audits one row', async () => {
    const ids = (await oceanWriters()).map((row) => row.id).sort();
    const audits = (await auditsOf()).length;
    const result = await service.updateWriterShares(withRole(owner, 'member'), {
      ...{ compositionId: OCEAN, expectedBeforeHash: await hash() },
      shares: [share(JORDAN, 6000), share(ALEX, 4000)],
    });
    if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
    expect(result.value.writerTotalBp).toBe(10000);
    const after = await oceanWriters();
    expect(after.map((row) => row.id).sort()).toEqual(ids);
    expect(Object.fromEntries(after.map((row) => [row.partyId, row.writerShareBp]))).toEqual({
      ...{ [JORDAN]: 6000, [ALEX]: 4000 },
    });
    const rows = await auditsOf();
    expect(rows).toHaveLength(audits + 1);
    expect(rows.at(-1)).toMatchObject({
      action: 'writer_shares.replace',
      requestId: owner.requestId,
    });
    expect(JSON.parse(rows.at(-1)?.afterJson ?? '{}').shares).toHaveLength(2);
    await consistent();
  });

  it('removes a writer with his roles and adds one, allowing a total under 10000', async () => {
    const alexRow = (await oceanWriters()).find((row) => row.partyId === ALEX);
    const theo = NORTHSTAR.keys.pty_THEO;
    const result = await service.updateWriterShares(owner, {
      compositionId: OCEAN,
      shares: [
        share(JORDAN, 6000),
        { partyId: theo, roles: ['composer', 'lyricist'], shareBp: 2500 },
      ],
    });
    if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
    expect(result.value.writerTotalBp).toBe(8500);
    const held = await (await open(owner))
      .select()
      .from(roles)
      .where(inArray(roles.contributorId, [alexRow?.id ?? '']));
    expect(held).toEqual([]);
    expect((await oceanWriters()).map((row) => row.partyId).sort()).toEqual([JORDAN, theo].sort());
    await consistent();
  });

  it('refuses before writing: bad shares, an organization, a stale hash, a missing song', async () => {
    const silverline = NORTHSTAR.keys.pty_SILVERLINE;
    const before = await hash();
    const audits = (await auditsOf()).length;
    const cases: [Parameters<Shares['updateWriterShares']>[1], object][] = [
      [
        { compositionId: OCEAN, shares: [share(JORDAN, 6000), share(ALEX, 4001)] },
        invalid('total_over_10000'),
      ],
      [
        { compositionId: OCEAN, shares: [share(JORDAN, 1), share(JORDAN, 1)] },
        invalid('duplicate_party'),
      ],
      [
        { compositionId: OCEAN, shares: [{ ...share(JORDAN, 1), roles: [] }] },
        invalid('roles_count'),
      ],
      [{ compositionId: OCEAN, shares: [share(JORDAN, 10001)] }, invalid('share_out_of_range')],
      [{ compositionId: OCEAN, shares: [share(silverline, 100)] }, invalid('person_required')],
      [
        { compositionId: OCEAN, shares: [share(JORDAN, 100)], expectedBeforeHash: 'stale' },
        refused({ code: 'STATE_CHANGED' }),
      ],
      [{ compositionId: 'cmp_missing', shares: [] }, refused({ code: 'NOT_FOUND' })],
      [{ compositionId: OCEAN, shares: [share('pty_missing', 1)] }, refused({ code: 'NOT_FOUND' })],
    ];
    for (const [input, refusal] of cases)
      expect(await service.updateWriterShares(owner, input), JSON.stringify(input)).toEqual(
        refusal,
      );
    expect(await hash()).toBe(before);
    expect(await auditsOf()).toHaveLength(audits);
    const other = await services.provision('owner');
    expect(await service.updateWriterShares(other, { compositionId: OCEAN, shares: [] })).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
    services.getWorkspaceDatabase.mockClear();
    const viewer = withRole(owner, 'viewer');
    expect(await service.updateWriterShares(viewer, { compositionId: OCEAN, shares: [] })).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    await consistent();
  });
});
