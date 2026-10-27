import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { prepareWorkspaceServices, withRole } from './workspace-service';

const fixture = JSON.parse(readFileSync('docs/fixtures/northstar-demo.json', 'utf8'));
const { keys } = fixture as { keys: Record<string, string> };
const AT = '2026-09-15T12:00:00.000Z';
let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let search: typeof import('../../src/server/services/catalog/search');
let owner: TenantContext;

/** EXPECTED.md §5's searchMusic rows: query, MATCH expression, result, matchType and primary. */
const EXPECTED = readFileSync('docs/fixtures/EXPECTED.md', 'utf8')
  .split('\n')
  .filter((line) => line.includes('| searchMusic |'))
  .map((line) => {
    const cells = line.split('|').map((cell) => cell.trim().replace(/^`|`$/g, ''));
    const [, , , query, match, result, matchType, primary] = cells;
    return { query, match, result: keys[result], matchType, primary: keys[primary] };
  });

const found = async (query: string, tenant = owner, extra = {}) => {
  const result = await search.searchMusic(tenant, { query, ...extra });
  if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
  return result.value;
};

beforeAll(async () => {
  services = await prepareWorkspaceServices('catalog-search');
  search = await import('../../src/server/services/catalog/search');
  const { seedNorthstar } = await import('../../src/server/db/seed/northstar');
  const password = 'catalog-search-test-password';
  const seeded = await seedNorthstar({ password, seedDate: fixture.demo.date });
  if (seeded.status !== 'seeded') throw new Error(`Northstar was ${seeded.status}`);
  const { organizationId, workspaceId } = seeded;
  const ids = { userId: keys.usr_JORDAN, requestId: crypto.randomUUID() };
  owner = { ...ids, organizationId, workspaceId, workspaceRole: 'owner' };
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('CAT-INT-009: searchMusic returns one result per song (§3.5)', () => {
  it('matches every EXPECTED §5 row: MATCH expression, one result, matchType and primary recording', async () => {
    expect(EXPECTED.length).toBe(5);
    for (const row of EXPECTED) {
      expect(search.matchExpression(row.query), row.query).toBe(row.match);
      const results = await found(row.query);
      expect(results.map((r) => [r.compositionId, r.matchType, r.primaryRecordingId])).toEqual([
        [row.result, row.matchType, row.primary],
      ]);
      expect(results[0].recordingIds).toEqual([row.primary]);
    }
  });

  it('finds a song by prefix, and never throws on quotes, * or FTS keywords', async () => {
    expect((await found('midn')).map((r) => r.compositionId)).toEqual([keys.cmp_MIDNIGHT]);
    for (const query of ['"', '*', '"Midnight', 'NEAR(', 'a AND', '-x', '""*""', 'OR']) {
      await expect(found(query), query).resolves.toBeInstanceOf(Array);
    }
  });

  it('answers [] for text with no token without opening the database, and checks its input', async () => {
    services.getWorkspaceDatabase.mockClear();
    expect(await found('   ')).toEqual([]);
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    const refusal = (field: string, reason: string) => ({
      ok: false,
      error: { code: 'VALIDATION', field, reason },
    });
    const bad: [object, object][] = [
      [{ query: '' }, refusal('query', 'length')],
      [{ query: 'x'.repeat(201) }, refusal('query', 'length')],
      [{ query: 'x', limit: 0 }, refusal('limit', 'out_of_range')],
      [{ query: 'x', limit: 21 }, refusal('limit', 'out_of_range')],
      [{ query: 'x', readiness: 'ready' }, refusal('readiness', 'not_allowed')],
    ];
    for (const [input, refused] of bad) {
      expect(await search.searchMusic(owner, input as { query: string })).toEqual(refused);
    }
    expect(await search.searchMusic(withRole(owner, 'nobody'), { query: 'x' })).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await found('Ocean', withRole(owner, 'viewer'))).toHaveLength(1);
  });

  it('filters by readiness, artist and terms', async () => {
    const all = await found('a', owner, { limit: 20 });
    const ready = await found('a', owner, { limit: 20, readiness: 'one_stop_ready' });
    const notReady = await found('a', owner, { limit: 20, readiness: 'not_one_stop_ready' });
    for (const song of ready) expect(song.recordings.some((r) => r.oneStopReady)).toBe(true);
    for (const song of notReady) expect(song.recordings.some((r) => !r.oneStopReady)).toBe(true);
    const keyOf = (r: { compositionId: string | null }) => r.compositionId;
    expect(all.length).toBeGreaterThan(1);
    expect(new Set([...ready, ...notReady].map(keyOf))).toEqual(new Set(all.map(keyOf)));

    const alex = await found('Ocean', owner, { artistPartyId: keys.pty_ALEX });
    expect(alex.map(keyOf)).toEqual([keys.cmp_OCEAN]);
    expect(await found('Midnight', owner, { artistPartyId: keys.pty_ALEX })).toEqual([]);

    const database = await services.connections.getWorkspaceDatabase(owner.workspaceId);
    const [mood, genre] = [`trm_${ulid()}`, `trm_${ulid()}`];
    const term = (id: string, label: string, termType: string) => ({
      ...{ id, label, termType, normalizedLabel: label.toLowerCase(), createdAt: AT },
    });
    await database
      .insert(tables.metadataTerms)
      .values([term(mood, 'Dreamy', 'mood'), term(genre, 'Synthpop', 'genre')]);
    await database.insert(tables.compositionTerms).values([
      { compositionId: keys.cmp_OCEAN, termId: mood },
      { compositionId: keys.cmp_OCEAN, termId: genre },
      { compositionId: keys.cmp_MIDNIGHT, termId: mood },
    ]);
    await database
      .insert(tables.recordingTerms)
      .values({ recordingId: keys.rec_NEON, termId: mood });
    const termed = async (query: string, termIds: string[]) =>
      (await found(query, owner, { termIds })).map(keyOf);
    // On the composition, and on a recording, which folds into its song.
    expect(await termed('Midnight Drive', [mood])).toEqual([keys.cmp_MIDNIGHT]);
    expect(await termed('Neon Static', [mood])).toEqual([keys.cmp_NEON]);
    expect(await termed('Ocean Blue', [mood, genre])).toEqual([keys.cmp_OCEAN]);
    expect(await termed('Midnight Drive', [mood, genre])).toEqual([]);
    expect(await termed('Home Again', [mood])).toEqual([]);
  });

  it('returns two exact results for two distinct songs with one title, before text matches', async () => {
    const database = await services.connections.getWorkspaceDatabase(owner.workspaceId);
    const twin = `cmp_${ulid()}`;
    await database
      .insert(tables.compositions)
      .values({ id: twin, title: 'ocean  BLUE', createdAt: AT, updatedAt: AT });
    const results = await found('Ocean Blue');
    expect(results.map((r) => r.matchType)).toEqual(['exact_title', 'exact_title']);
    expect(new Set(results.map((r) => r.compositionId))).toEqual(new Set([keys.cmp_OCEAN, twin]));
    expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });
});
