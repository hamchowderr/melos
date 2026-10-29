import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingInput } from '../../src/lib/dto/catalog';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { catalogSearchOf, NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Recordings = typeof import('../../src/server/services/catalog/recordings');

let services: Services;
let service: Recordings;
let owner: TenantContext;
const { auditLog, compositions } = tables;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });
const invalid = (field: string, reason: string) => refused({ code: 'VALIDATION', field, reason });

beforeAll(async () => {
  services = await prepareWorkspaceServices('recordings');
  service = await import('../../src/server/services/catalog/recordings');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

/** The audit rows for one recording, oldest first, with their JSON parsed. */
async function auditOf(entityId: string) {
  const rows = await (await open(owner))
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityId, entityId));
  return rows.map(({ action, beforeJson, afterJson }) => ({
    ...{ action, before: beforeJson && JSON.parse(beforeJson) },
    after: afterJson && JSON.parse(afterJson),
  }));
}

/** catalog_search equals validate.mjs's derivation and every foreign key holds. */
async function consistent() {
  const database = await open(owner);
  const search = await catalogSearchOf(database);
  expect(search.indexed).toEqual(search.derived);
  expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
}

describe('melos-rpr.18: createRecording and duplicate recordings (CAT-002, CAT-005)', () => {
  it('adds a recording to a song with its links, normalizes the ISRC, audits and indexes it', async () => {
    const created = await service.createRecording(owner, {
      ...{ compositionId: NORTHSTAR.keys.cmp_OCEAN, title: ' Ocean Blue ', versionTitle: 'Live' },
      ...{ isrc: 'us-dmo-26-00009', durationMs: 201_000, bpm: 92.5, previewStartMs: 30_000 },
      links: [
        { url: 'https://media.example/ocean-live', isPrimary: true },
        { url: 'https://dsp.example/ocean', linkType: 'dsp', label: 'Stream' },
      ],
    });
    if (!created.ok) throw new Error(`Refused with ${created.error.code}`);
    const take = created.value.recordings.find((r) => r.versionTitle === 'Live');
    const id = take?.id ?? '';
    expect(take).toMatchObject({ isrc: 'USDMO2600009', versionTitle: 'Live', bpm: 92.5 });
    expect(take?.primaryLink?.url).toBe('https://media.example/ocean-live');
    expect(take?.links.map((link) => link.linkType)).toEqual(['private_player', 'dsp']);
    const [audit, ...more] = await auditOf(id);
    expect(more).toEqual([]);
    expect(audit).toMatchObject({ action: 'recording.create', before: null });
    expect(audit.after.links).toHaveLength(2);
    await consistent();
  });

  it('refuses before writing: bad fields, a second primary link, a bad or taken ISRC, a missing song', async () => {
    const database = await open(owner);
    const count = sql`SELECT count(*) AS n FROM recordings`;
    const [before] = await database.all(count);
    const gone = `cmp_${ulid()}`;
    const at = new Date().toISOString();
    await database
      .insert(compositions)
      .values({ id: gone, title: 'Gone', createdAt: at, updatedAt: at, deletedAt: at });
    const primary = { url: 'https://media.example/a', isPrimary: true };
    const cases: [RecordingInput, object][] = [
      [{ title: ' ' }, invalid('title', 'required')],
      [{ title: 'A', durationMs: -1 }, invalid('durationMs', 'not_a_whole_number')],
      [{ title: 'A', bpm: 0 }, invalid('bpm', 'not_positive')],
      [{ title: 'A', links: [primary, primary] }, invalid('links', 'more_than_one_primary')],
      [{ title: 'A', links: [{ url: ' ' }] }, invalid('links', 'required')],
      [
        { title: 'A', isrc: 'US-DMO-26' },
        refused({ code: 'INVALID_ISRC', field: 'isrc', reason: 'shape' }),
      ],
      // The first test's ISRC.
      [{ title: 'A', isrc: 'USDMO2600009' }, refused({ code: 'CONFLICT', field: 'isrc' })],
      [{ title: 'A', compositionId: gone }, refused({ code: 'NOT_FOUND' })],
    ];
    for (const [input, refusal] of cases)
      expect(await service.createRecording(owner, input), JSON.stringify(input)).toEqual(refusal);
    expect(await database.all(count)).toEqual([before]);
    services.getWorkspaceDatabase.mockClear();
    const viewer = withRole(owner, 'viewer');
    expect(await service.createRecording(viewer, { title: 'A' })).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for another workspace's song and audits the actor and request", async () => {
    const other = await services.provision('owner');
    const ocean = NORTHSTAR.keys.cmp_OCEAN;
    expect(await service.createRecording(other, { compositionId: ocean, title: 'X' })).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
    const member = withRole(owner, 'member');
    const created = await service.createRecording(member, { title: 'Member Take' });
    if (!created.ok) throw new Error(`Refused with ${created.error.code}`);
    const where = eq(auditLog.entityId, created.value.focus.entityId);
    const [row] = await (await open(owner)).select().from(auditLog).where(where);
    expect(row).toMatchObject({ actorUserId: owner.userId, requestId: owner.requestId });
  });

  it('finds live recordings with the same ISRC, or the same song, title and version title', async () => {
    const found = await service.findRecordingDuplicates(owner, {
      ...{ compositionId: NORTHSTAR.keys.cmp_OCEAN, title: 'ocean  BLUE', versionTitle: ' live' },
      isrc: 'US-DMO-26-00009',
    });
    if (!found.ok) throw new Error(`Refused with ${found.error.code}`);
    expect(found.value.map((d) => [d.title, d.matchedOn])).toEqual([
      ['Ocean Blue', ['isrc', 'title']],
    ]);
  });
});
