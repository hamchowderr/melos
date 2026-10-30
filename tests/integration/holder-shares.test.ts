import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Shares = typeof import('../../src/server/services/rights/holder-shares');

let services: Services;
let service: Shares;
let owner: TenantContext;
const { auditLog, masterInterests: masters, publishingInterests: publishers } = tables;
const { cmp_OCEAN: OCEAN, rec_NEON: NEON } = NORTHSTAR.keys;
const {
  pty_SILVERLINE: SILVERLINE,
  pty_NIGHTSHIFT: NIGHTSHIFT,
  pty_NEXTWAVE: NEXTWAVE,
} = NORTHSTAR.keys;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });
const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code);

beforeAll(async () => {
  services = await prepareWorkspaceServices('holder-shares');
  service = await import('../../src/server/services/rights/holder-shares');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const auditsOf = async (entityId: string) =>
  (await open(owner)).select().from(auditLog).where(eq(auditLog.entityId, entityId));
const noForeignKeyErrors = async () =>
  expect(await (await open(owner)).all(sql`PRAGMA foreign_key_check`)).toEqual([]);

describe('melos-rpr.28: updatePublishingShares and updateMasterShares (RGT-002, 003, 007)', () => {
  it('sets Ocean Blue publishing to 7500/2500, keeping ids and attestations, and clears the issue', async () => {
    const database = await open(owner);
    const ocean = eq(publishers.compositionId, OCEAN);
    const at = new Date().toISOString();
    await database
      .update(publishers)
      .set({ representationAttestedAt: at, representationAttestedBy: owner.userId })
      .where(and(ocean, eq(publishers.publisherPartyId, NIGHTSHIFT)));
    const ids = (await database.select().from(publishers).where(ocean)).map((r) => r.id).sort();
    const audits = (await auditsOf(OCEAN)).length;
    const result = await service.updatePublishingShares(withRole(owner, 'member'), {
      ...{ compositionId: OCEAN, territory: 'WORLD' },
      shares: [
        { partyId: SILVERLINE, shareBp: 7500 },
        { partyId: NIGHTSHIFT, shareBp: 2500 },
      ],
    });
    if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
    expect(result.value.publishing).toMatchObject([{ territory: 'WORLD', totalBp: 10000 }]);
    expect(codes(result.value.issues)).not.toContain('PUBLISHING_TOTAL_INCOMPLETE');
    const after = await database.select().from(publishers).where(ocean);
    expect(after.map((r) => r.id).sort()).toEqual(ids);
    expect(after.find((r) => r.publisherPartyId === NIGHTSHIFT)?.representationAttestedAt).toBe(at);
    const rows = await auditsOf(OCEAN);
    expect(rows).toHaveLength(audits + 1);
    expect(rows.at(-1)).toMatchObject({ action: 'publishing_shares.replace' });
    await noForeignKeyErrors();
  });

  it('refuses a US set beside the WORLD set, and other bad input, writing nothing', async () => {
    const before = await (await open(owner)).select().from(publishers);
    const audits = (await auditsOf(OCEAN)).length;
    const one = [{ partyId: SILVERLINE, shareBp: 5000 }];
    const cases: [Parameters<Shares['updatePublishingShares']>[1], object][] = [
      [
        { compositionId: OCEAN, territory: 'US', shares: one },
        refused({ code: 'VALIDATION', field: 'territory', reason: 'mixes_world_and_countries' }),
      ],
      [
        { compositionId: OCEAN, territory: 'usa', shares: one },
        refused({ code: 'VALIDATION', field: 'territory', reason: 'unknown_territory' }),
      ],
      [
        {
          compositionId: OCEAN,
          territory: 'WORLD',
          shares: [...one, { partyId: NIGHTSHIFT, shareBp: 5001 }],
        },
        refused({ code: 'VALIDATION', field: 'shares', reason: 'total_over_10000' }),
      ],
      [
        { compositionId: OCEAN, territory: 'WORLD', shares: one, expectedBeforeHash: 'stale' },
        refused({ code: 'STATE_CHANGED' }),
      ],
      [
        { compositionId: OCEAN, territory: 'WORLD', shares: [{ ...one[0], agreementId: 'agr_x' }] },
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'NOT_FOUND' }),
        }),
      ],
    ];
    for (const [input, refusal] of cases)
      expect(await service.updatePublishingShares(owner, input), JSON.stringify(input)).toEqual(
        refusal,
      );
    expect(await (await open(owner)).select().from(publishers)).toEqual(before);
    expect(await auditsOf(OCEAN)).toHaveLength(audits);
    await noForeignKeyErrors();
  });

  it('sets Neon Static master to 7500/2500 and clears MASTER_TOTAL_INCOMPLETE', async () => {
    const result = await service.updateMasterShares(owner, {
      recordingId: NEON,
      shares: [
        { partyId: NIGHTSHIFT, shareBp: 7500 },
        { partyId: NEXTWAVE, shareBp: 2500 },
      ],
    });
    if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
    expect(result.value.masters).toMatchObject([{ recordingId: NEON, totalBp: 10000 }]);
    expect(codes(result.value.issues)).not.toContain('MASTER_TOTAL_INCOMPLETE');
    const rows = await (await open(owner))
      .select()
      .from(masters)
      .where(eq(masters.recordingId, NEON));
    expect(rows).toHaveLength(2);
    expect((await auditsOf(NEON)).at(-1)).toMatchObject({ action: 'master_shares.replace' });
    await noForeignKeyErrors();
  });

  it('refuses a viewer before the database opens, and another workspace', async () => {
    services.getWorkspaceDatabase.mockClear();
    const viewer = withRole(owner, 'viewer');
    const forbidden = refused({ code: 'FORBIDDEN' });
    expect(await service.updateMasterShares(viewer, { recordingId: NEON, shares: [] })).toEqual(
      forbidden,
    );
    expect(
      await service.updatePublishingShares(viewer, {
        ...{ compositionId: OCEAN, territory: 'WORLD', shares: [] },
      }),
    ).toEqual(forbidden);
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    const other = await services.provision('owner');
    expect(await service.updateMasterShares(other, { recordingId: NEON, shares: [] })).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
  });

  it('loads each set hash for the editors, which a save accepts once (RGT-002, RGT-003)', async () => {
    const loaded = await service.getHolderSharesHashes(owner, {
      compositionId: OCEAN,
      recordingIds: [NEON],
    });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    const { publishing, masters: masterHashes, empty } = loaded.value;
    expect(Object.keys(publishing)).toEqual(['WORLD']);
    expect(empty).toBe(service.holderSetHash([]));
    const shares = [{ partyId: SILVERLINE, shareBp: 10_000 }];
    const first = { recordingId: NEON, shares, expectedBeforeHash: masterHashes[NEON] };
    expect((await service.updateMasterShares(owner, first)).ok).toBe(true);
    expect(await service.updateMasterShares(owner, first)).toEqual(
      refused({ code: 'STATE_CHANGED' }),
    );
  });
});
