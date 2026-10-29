import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { catalogSearchOf, NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Artists = typeof import('../../src/server/services/catalog/artists');

let services: Services;
let service: Artists;
let owner: TenantContext;
const { artistAliases, auditLog, recordingArtists } = tables;
const { rec_OCEAN: OCEAN, pty_JORDAN: JORDAN, pty_ALEX: ALEX, pty_THEO: THEO } = NORTHSTAR.keys;
/** Theo's stage name, the alias the new credit names. */
const LANTERN = ulid();

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });

beforeAll(async () => {
  services = await prepareWorkspaceServices('recording-artists');
  service = await import('../../src/server/services/catalog/artists');
  owner = await seedNorthstarTenant();
  await (await open(owner)).insert(artistAliases).values({
    ...{ id: LANTERN, partyId: THEO, aliasName: 'Lantern Theo' },
    createdAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const auditsOf = async () =>
  (await open(owner)).select().from(auditLog).where(eq(auditLog.entityId, OCEAN));
const credits = async () =>
  (await open(owner))
    .select()
    .from(recordingArtists)
    .where(eq(recordingArtists.recordingId, OCEAN));

async function consistent() {
  const database = await open(owner);
  const search = await catalogSearchOf(database);
  expect(search.indexed).toEqual(search.derived);
  expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
}

describe('melos-rpr.19: updateRecordingArtists (CAT-003, CAT-INT-003)', () => {
  it('removes Alex from Ocean Blue, credits a new artist and audits both sets once', async () => {
    const jordan = (await credits()).find((row) => row.partyId === JORDAN);
    const audits = (await auditsOf()).length;
    const result = await service.updateRecordingArtists(withRole(owner, 'member'), OCEAN, [
      { partyId: JORDAN, role: 'primary' },
      { partyId: THEO, role: 'featured', artistAliasId: LANTERN },
    ]);
    if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
    const after = await credits();
    expect(after.find((row) => row.partyId === JORDAN)?.id).toBe(jordan?.id);
    expect(after.map((row) => [row.partyId, row.role, row.billingOrder])).toEqual(
      expect.arrayContaining([
        [JORDAN, 'primary', 0],
        [THEO, 'featured', 1],
      ]),
    );
    expect(after.some((row) => row.partyId === ALEX)).toBe(false);
    const rows = await auditsOf();
    expect(rows).toHaveLength(audits + 1);
    const audit = rows.at(-1);
    expect(audit).toMatchObject({ action: 'recording_artists.replace', actorUserId: owner.userId });
    const parties = (json: string | null | undefined) =>
      JSON.parse(json ?? '{}').artists.map((a: { partyId: string }) => a.partyId);
    expect(parties(audit?.beforeJson)).toEqual([JORDAN, ALEX]);
    expect(parties(audit?.afterJson)).toEqual([JORDAN, THEO]);
    const search = await catalogSearchOf(await open(owner));
    expect(JSON.stringify(search.indexed)).toContain('Jordan Taylor Theo Grant');
    await consistent();
    // The same set again changes nothing and writes nothing.
    const again = await service.updateRecordingArtists(owner, OCEAN, [
      { partyId: JORDAN, role: 'primary' },
      { partyId: THEO, role: 'featured', artistAliasId: LANTERN },
    ]);
    expect(again.ok).toBe(true);
    expect(await auditsOf()).toHaveLength(audits + 1);
  });

  it('refuses before writing: bad credits, an alias of another party, a missing party', async () => {
    const before = await credits();
    const audits = (await auditsOf()).length;
    const invalid = (reason: string) => refused({ code: 'VALIDATION', field: 'artists', reason });
    const cases: [Parameters<Artists['updateRecordingArtists']>[2], object][] = [
      [[{ partyId: JORDAN, role: 'remixer' as never }], invalid('unknown_role')],
      [
        [
          { partyId: JORDAN, role: 'primary' },
          { partyId: JORDAN, role: 'primary' },
        ],
        invalid('duplicate_artist'),
      ],
      [[{ partyId: JORDAN, role: 'primary', billingOrder: -1 }], invalid('not_a_whole_number')],
      [
        [{ partyId: JORDAN, role: 'primary', artistAliasId: LANTERN }],
        invalid('alias_of_other_party'),
      ],
      [[{ partyId: `pty_${ulid()}`, role: 'primary' }], refused({ code: 'NOT_FOUND' })],
    ];
    for (const [artists, refusal] of cases)
      expect(await service.updateRecordingArtists(owner, OCEAN, artists)).toEqual(refusal);
    expect(await service.updateRecordingArtists(owner, `rec_${ulid()}`, [])).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
    expect(await credits()).toEqual(before);
    expect(await auditsOf()).toHaveLength(audits);
    const other = await services.provision('owner');
    expect(await service.updateRecordingArtists(other, OCEAN, [])).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
    services.getWorkspaceDatabase.mockClear();
    expect(await service.updateRecordingArtists(withRole(owner, 'viewer'), OCEAN, [])).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    await consistent();
  });
});
