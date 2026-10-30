import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { catalogSearchOf, NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let terms: typeof import('../../src/server/services/catalog/terms');
let recordings: typeof import('../../src/server/services/catalog/recordings');
let search: typeof import('../../src/server/services/catalog/search');
let owner: TenantContext;
const { auditLog, metadataTerms, recordingTerms } = tables;
const { rec_OCEAN: OCEAN, rec_HOME: HOME } = NORTHSTAR.keys;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });

beforeAll(async () => {
  services = await prepareWorkspaceServices('metadata-terms');
  terms = await import('../../src/server/services/catalog/terms');
  recordings = await import('../../src/server/services/catalog/recordings');
  search = await import('../../src/server/services/catalog/search');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

async function accepted<T>(
  pending: Promise<{ ok: true; value: T } | { ok: false; error: object }>,
) {
  const result = await pending;
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}
const linksOf = async (recordingId: string) =>
  (
    await (
      await open(owner)
    )
      .select()
      .from(recordingTerms)
      .where(eq(recordingTerms.recordingId, recordingId))
  )
    .map((row) => row.termId)
    .sort();

async function consistent() {
  const database = await open(owner);
  const index = await catalogSearchOf(database);
  expect(index.indexed).toEqual(index.derived);
  expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
}

describe('melos-rpr.25: ensureTerms and recording terms (CAT-006, CAT-INT-006)', () => {
  it('resolves Synth Pop and " synth pop " to one term and audits it once', async () => {
    const found = await accepted(
      terms.ensureTerms(withRole(owner, 'member'), [
        { termType: 'genre', label: 'Synth Pop' },
        { termType: 'genre', label: ' synth  pop ' },
        { termType: 'mood', label: 'Wistful' },
      ]),
    );
    expect(found.map((term) => [term.termType, term.label])).toEqual([
      ['genre', 'Synth Pop'],
      ['mood', 'Wistful'],
    ]);
    const again = await accepted(
      terms.ensureTerms(owner, [{ termType: 'genre', label: 'SYNTH POP' }]),
    );
    expect(again[0].id).toBe(found[0].id);
    const database = await open(owner);
    const synth = await database
      .select()
      .from(metadataTerms)
      .where(eq(metadataTerms.normalizedLabel, 'synth pop'));
    expect(synth).toHaveLength(1);
    const audits = await database.select().from(auditLog).where(eq(auditLog.entityId, found[0].id));
    expect(audits.map((row) => row.action)).toEqual(['metadata_term.create']);
  });

  it('replaces only this recording’s links, reindexes, and search finds the song by term', async () => {
    const [synth, wistful, dreamy] = await accepted(
      terms.ensureTerms(owner, [
        { termType: 'genre', label: 'Synth Pop' },
        { termType: 'mood', label: 'Wistful' },
        { termType: 'mood', label: 'Dreamy' },
      ]),
    );
    await accepted(recordings.updateRecording(owner, OCEAN, { termIds: [synth.id, wistful.id] }));
    await accepted(recordings.updateRecording(owner, HOME, { termIds: [synth.id] }));
    await accepted(recordings.updateRecording(owner, OCEAN, { termIds: [dreamy.id] }));
    expect(await linksOf(OCEAN)).toEqual([dreamy.id]);
    expect(await linksOf(HOME)).toEqual([synth.id]);
    const found = await accepted(search.searchMusic(owner, { query: 'Dreamy' }));
    expect(found.map((song) => song.title)).toEqual(['Ocean Blue']);
    await consistent();
    const database = await open(owner);
    const [last] = (
      await database.select().from(auditLog).where(eq(auditLog.entityId, OCEAN))
    ).slice(-1);
    expect(last.action).toBe('recording.update');
    expect(JSON.parse(last.afterJson ?? '{}').termIds).toEqual([dreamy.id]);
    const count = (await database.select().from(auditLog).where(eq(auditLog.entityId, OCEAN)))
      .length;
    await accepted(recordings.updateRecording(owner, OCEAN, { termIds: [dreamy.id, dreamy.id] }));
    expect(
      (await database.select().from(auditLog).where(eq(auditLog.entityId, OCEAN))).length,
    ).toBe(count);
  });

  it('refuses bad terms, an unknown term id, a viewer and another workspace', async () => {
    expect(await terms.ensureTerms(owner, [{ termType: 'tempo' as never, label: 'Fast' }])).toEqual(
      refused({ code: 'VALIDATION', field: 'terms', reason: 'unknown_term_type' }),
    );
    expect(await terms.ensureTerms(owner, [{ termType: 'genre', label: ' ' }])).toEqual(
      refused({ code: 'VALIDATION', field: 'terms', reason: 'required' }),
    );
    const missing = await recordings.updateRecording(owner, OCEAN, { termIds: ['trm_missing'] });
    expect(missing).toMatchObject(refused({ code: 'NOT_FOUND' }));
    await consistent();
    services.getWorkspaceDatabase.mockClear();
    expect(await terms.ensureTerms(withRole(owner, 'viewer'), [])).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    const other = await services.provision('owner');
    expect(await recordings.updateRecording(other, OCEAN, { termIds: [] })).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
  });
});
