import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReleaseInput, ReleasePatch, ReleaseType } from '../../src/lib/dto/catalog';
import * as tables from '../../src/server/db/schema/workspace.generated';
import { canonicalJson } from '../../src/server/services/audit-writer';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { prepareWorkspaceServices, withRole } from './workspace-service';

const AT = '2026-09-15T12:00:00.000Z';
/** In the first workspace: two live parties and a soft-deleted one, recordings A to C and DELETED. */
const [LABEL, DISTRIBUTOR, GONE] = [`pty_${ulid()}`, `pty_${ulid()}`, `pty_${ulid()}`];
const [A, B, C, DELETED] = Array.from({ length: 4 }, () => `rec_${ulid()}`);
const ok = (value: unknown) => ({ ok: true, value });
const refused = (error: object) => ({ ok: false, error });
const [FORBIDDEN, NOT_FOUND] = [refused({ code: 'FORBIDDEN' }), refused({ code: 'NOT_FOUND' })];
const CONFLICT = refused({ code: 'CONFLICT', field: 'upcEan' });
const missing = (table: string) => refused({ code: 'NOT_FOUND', counts: { [table]: 1 } });
const badUpc = (reason: string) => refused({ code: 'INVALID_UPC_EAN', field: 'upcEan', reason });
const at = (recordingId: string, trackNumber: number | null, discNumber = 1) => ({
  ...{ recordingId, discNumber, trackNumber },
});
let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let service: typeof import('../../src/server/services/catalog/releases');
let owner: TenantContext;
let other: TenantContext;

const create = (input: ReleaseInput, tenant = owner) => service.createRelease(tenant, input);
const get = (id: string, tenant = owner) => service.getRelease(tenant, id);
const update = (id: string, patch: ReleasePatch, tenant = owner) =>
  service.updateRelease(tenant, id, patch);
async function accepted<T>(pending: Promise<ServiceResult<T>>): Promise<T> {
  const result = await pending;
  if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
  return result.value;
}
const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
/** The tenant's releases and audit rows, once PRAGMA foreign_key_check is empty (DAT-INT-001). */
async function stored(tenant = owner) {
  const database = await open(tenant);
  expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  const { releases, auditLog } = tables;
  return database.batch([database.select().from(releases), database.select().from(auditLog)]);
}

beforeAll(async () => {
  services = await prepareWorkspaceServices('releases');
  service = await import('../../src/server/services/catalog/releases');
  [owner, other] = [await services.provision('owner'), await services.provision('owner')];
  const database = await open(owner);
  const row = (id: string) => ({ id, deletedAt: [GONE, DELETED].includes(id) ? AT : null });
  const stamps = { createdAt: AT, updatedAt: AT };
  const party = { ...stamps, partyKind: 'organization', displayName: 'Party' };
  const take = { ...stamps, title: 'Take' };
  await database.batch([
    database
      .insert(tables.parties)
      .values([LABEL, DISTRIBUTOR, GONE].map((id) => ({ ...row(id), ...party }))),
    database
      .insert(tables.recordings)
      .values([A, B, C, DELETED].map((id) => ({ ...row(id), ...take }))),
  ]);
});

afterAll(() => services?.close());

describe('melos-rpr.14: releases with ordered tracks (CAT-007)', () => {
  it('lets owner, admin and member create; viewer and owner,viewer get FORBIDDEN before the database opens (§6.2)', async () => {
    let id = '';
    services.getWorkspaceDatabase.mockClear();
    for (const role of ['owner', 'admin', 'member']) {
      id = (await accepted(create({ title: role }, withRole(owner, role)))).id;
    }
    expect(services.getWorkspaceDatabase).toHaveBeenCalledTimes(3);
    services.getWorkspaceDatabase.mockClear();
    for (const role of ['viewer', 'owner,viewer']) {
      expect(await create({ title: role }, withRole(owner, role)), role).toEqual(FORBIDDEN);
      // The permission comes before validation.
      expect(await create({ title: '' }, withRole(owner, role)), role).toEqual(FORBIDDEN);
    }
    expect(await get(id, withRole(owner, 'owner,viewer'))).toEqual(FORBIDDEN);
    expect(services.getWorkspaceDatabase.mock.calls).toEqual([]);
    expect(await get(id, withRole(owner, 'viewer'))).toMatchObject(ok({ title: 'member' }));
    await stored();
  });

  it('keeps leading zeros and track order, and audits a create once with its tracks (CAT-INT-007, AUD-INT-001)', async () => {
    const [, earlier] = await stored();
    const fields = {
      ...{ title: ' Night Tapes ', releaseType: 'ep' as ReleaseType, upcEan: '0 36000 29145 2' },
      ...{ labelPartyId: LABEL, distributorPartyId: DISTRIBUTOR, releaseDate: '2026-09-01' },
    };
    const tracks = [at(C, 1, 2), { recordingId: B, trackNumber: null }, at(A, 1)];
    const created = await accepted(create({ ...fields, tracks }));
    const byId = eq(tables.releases.id, created.id);
    const [row] = await (await open(owner)).select().from(tables.releases).where(byId);
    const by = { createdBy: owner.userId, updatedBy: owner.userId, notes: null, deletedAt: null };
    const times = { id: created.id, createdAt: row.updatedAt, updatedAt: row.updatedAt };
    expect(row).toEqual({
      ...fields,
      ...by,
      ...times,
      title: 'Night Tapes',
      upcEan: '036000291452',
    });
    // By disc, then track number, an unnumbered track last on its disc.
    expect(created).toEqual({ ...row, tracks: [at(A, 1), at(B, null), at(C, 1, 2)] });
    expect(await get(created.id)).toEqual(ok(created));
    const actor = { actorType: 'user', actorUserId: owner.userId, requestId: owner.requestId };
    const entry = { ...actor, entityType: 'release', entityId: created.id };
    const [, audits] = await stored();
    expect(audits.slice(earlier.length)).toMatchObject([
      { ...entry, action: 'release.create', beforeJson: null, afterJson: canonicalJson(created) },
    ]);
  });

  it('refuses a UPC/EAN a live release holds, as UPC-A or EAN-13, with CONFLICT and a bad one with INVALID_UPC_EAN, writing nothing (D-1)', async () => {
    await accepted(create({ title: 'UPC-A', upcEan: '012345678905' }));
    const ean = await accepted(create({ title: 'EAN-13', upcEan: '0042100005264' }));
    const earlier = await stored();
    for (const [upcEan, refusal] of [
      ['0012345678905', CONFLICT],
      ['042100005264', CONFLICT],
      ['0-12345-67890-5', CONFLICT],
      ['036000291453', badUpc('check_digit')],
      ['1234567', badUpc('shape')],
    ] as const) {
      expect(await create({ title: 'New', upcEan }), upcEan).toEqual(refusal);
    }
    expect(await stored()).toEqual(earlier);
    // A soft-deleted release holds no UPC/EAN.
    const byId = eq(tables.releases.id, ean.id);
    await (await open(owner)).update(tables.releases).set({ deletedAt: AT }).where(byId);
    expect(await get(ean.id)).toEqual(NOT_FOUND);
    const reissue = await create({ title: 'Reissue', upcEan: '042100005264' });
    expect(reissue).toMatchObject(ok({ upcEan: '042100005264' }));
  });

  it('refuses a missing or soft-deleted label, distributor or recording with NOT_FOUND and counts, and ids from another workspace, writing nothing (§4.4 rule 1, TEN-001)', async () => {
    const kept = await accepted(create({ title: 'Kept', labelPartyId: LABEL, tracks: [at(A, 1)] }));
    const earlier = await stored();
    for (const [fields, refusal] of [
      [{ labelPartyId: GONE }, missing('parties')],
      [{ distributorPartyId: `pty_${ulid()}` }, missing('parties')],
      [{ tracks: [at(DELETED, 1)] }, missing('recordings')],
    ] as [Partial<ReleaseInput>, object][]) {
      expect(await create({ title: 'New', ...fields })).toEqual(refusal);
    }
    expect([await get(`rel_${ulid()}`), await stored()]).toEqual([NOT_FOUND, earlier]);
    expect(await get(kept.id, other)).toEqual(NOT_FOUND);
    expect(await create({ title: 'New', labelPartyId: LABEL }, other)).toEqual(missing('parties'));
    expect(await create({ title: 'New', tracks: [at(A, 1)] }, other)).toEqual(
      missing('recordings'),
    );
    expect(await stored(other)).toEqual([[], []]);
  });

  it('refuses broken fields with VALIDATION before the database opens', async () => {
    services.getWorkspaceDatabase.mockClear();
    for (const [fields, field, reason] of [
      [{ title: '  ' }, 'title', 'required'],
      [{ releaseType: 'lp' as ReleaseType }, 'releaseType', 'not_allowed'],
      [{ releaseDate: '2026-02-30' }, 'releaseDate', 'not_a_date'],
      [{ tracks: [at(A, 1, 0)] }, 'tracks', 'not_a_position'],
      [{ tracks: [at(A, 0)] }, 'tracks', 'not_a_position'],
      [{ tracks: [at(A, 1), at(A, 2)] }, 'tracks', 'duplicate_recording'],
      [{ tracks: [at(A, 1), at(B, 1)] }, 'tracks', 'duplicate_position'],
    ] as [Partial<ReleaseInput>, string, string][]) {
      const refusal = refused({ code: 'VALIDATION', field, reason });
      expect(await create({ title: 'New', ...fields }), reason).toEqual(refusal);
    }
    expect(services.getWorkspaceDatabase.mock.calls).toEqual([]);
  });

  it('patches the fields given, replaces tracks by recording, and audits once before and after (AUD-INT-001)', async () => {
    const created = await accepted(
      create({ title: 'Edit Me', upcEan: '077777777770', tracks: [at(A, 1), at(B, 2)] }),
    );
    const [, earlier] = await stored();
    const patched = await accepted(
      update(created.id, {
        ...{ title: ' Edited ', releaseType: 'album', labelPartyId: LABEL, upcEan: null },
        tracks: [at(B, 1), at(C, 2)],
      }),
    );
    expect(patched).toMatchObject({ title: 'Edited', releaseType: 'album', upcEan: null });
    expect(patched.tracks).toEqual([at(B, 1), at(C, 2)]);
    expect(patched.updatedAt >= created.updatedAt).toBe(true);
    const [, audits] = await stored();
    const entry = { entityType: 'release', entityId: created.id, actorUserId: owner.userId };
    expect(audits.slice(earlier.length)).toMatchObject([
      {
        ...{ ...entry, action: 'release.update', requestId: owner.requestId },
        ...{ beforeJson: canonicalJson(created), afterJson: canonicalJson(patched) },
      },
    ]);
    // The same values again, tracks in another order, change nothing and add no audit row.
    const same = { title: 'Edited', tracks: [at(C, 2), at(B, 1)] };
    expect(await update(created.id, same)).toEqual(ok(patched));
    expect((await stored())[1]).toHaveLength(audits.length);
  });

  it('checks a UPC/EAN only when it changes, refuses one another release holds, and keeps a legacy value', async () => {
    const held = await accepted(create({ title: 'Held', upcEan: '0-12345-67891-2' }));
    const mine = await accepted(create({ title: 'Mine', upcEan: '009876543215' }));
    // A stored value that would fail today's check digit, as an import could leave it.
    const legacy = await accepted(create({ title: 'Legacy' }));
    const byId = eq(tables.releases.id, legacy.id);
    await (await open(owner)).update(tables.releases).set({ upcEan: '036000291453' }).where(byId);
    const earlier = await stored();
    expect(await update(mine.id, { upcEan: held.upcEan })).toEqual(CONFLICT);
    expect(await update(mine.id, { upcEan: '036000291453' })).toEqual(badUpc('check_digit'));
    expect(await update(mine.id, { tracks: [at(DELETED, 1)] })).toEqual(missing('recordings'));
    expect(await stored()).toEqual(earlier);
    // Its own value, as EAN-13, is no conflict.
    expect(await update(mine.id, { upcEan: '0009876543215' })).toMatchObject(
      ok({ upcEan: '0009876543215' }),
    );
    expect(await update(legacy.id, { title: 'Legacy Edit' })).toMatchObject(
      ok({ title: 'Legacy Edit', upcEan: '036000291453' }),
    );
  });

  it('refuses a missing, deleted or foreign release with NOT_FOUND, a viewer with FORBIDDEN and bad fields with VALIDATION, before writing', async () => {
    const kept = await accepted(create({ title: 'Kept for update' }));
    services.getWorkspaceDatabase.mockClear();
    expect(await update(kept.id, { title: 'X' }, withRole(owner, 'viewer'))).toEqual(FORBIDDEN);
    expect(await update(kept.id, { title: ' ' })).toEqual(
      refused({ code: 'VALIDATION', field: 'title', reason: 'required' }),
    );
    expect(await update(kept.id, { tracks: [at(A, 1), at(A, 2)] })).toEqual(
      refused({ code: 'VALIDATION', field: 'tracks', reason: 'duplicate_recording' }),
    );
    expect(services.getWorkspaceDatabase.mock.calls).toEqual([]);
    expect(await update(`rel_${ulid()}`, { title: 'X' })).toEqual(NOT_FOUND);
    expect(await update(kept.id, { title: 'X' }, other)).toEqual(NOT_FOUND);
    const byId = eq(tables.releases.id, kept.id);
    await (await open(owner)).update(tables.releases).set({ deletedAt: AT }).where(byId);
    expect(await update(kept.id, { title: 'X' })).toEqual(NOT_FOUND);
    await stored();
  });
});
