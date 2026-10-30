import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type LookupDeps,
  lookupIsrc,
  minimumGap,
  USER_AGENT,
} from '../../src/server/services/catalog/lookup';
import type { TenantContext } from '../../src/server/services/tenant-context';

// IMP-INT-017 against responses recorded on 2026-10-30 (tests/fixtures/lookup/README.md).
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/lookup/${name}.json`, import.meta.url), 'utf8');

const FOUND = 'GBDUW0000059';
const MISSING = 'QZZZZ9999999';
const WORK = 'fb670a7d-4e22-3f65-8d3f-7cf2c29c6601';

const RECORDED: Record<string, [number, string]> = {
  [`https://api.deezer.com/track/isrc:${FOUND}`]: [200, 'deezer-track-isrc-found'],
  [`https://api.deezer.com/track/isrc:${MISSING}`]: [200, 'deezer-track-isrc-missing'],
  'https://api.deezer.com/album/302127': [200, 'deezer-album'],
  [`https://musicbrainz.org/ws/2/isrc/${FOUND}?fmt=json&inc=artist-credits+work-rels`]: [
    200,
    'musicbrainz-isrc-found',
  ],
  [`https://musicbrainz.org/ws/2/isrc/${MISSING}?fmt=json&inc=artist-credits+work-rels`]: [
    404,
    'musicbrainz-isrc-missing',
  ],
  [`https://musicbrainz.org/ws/2/work/${WORK}?fmt=json`]: [200, 'musicbrainz-work'],
};

function recorded(overrides: Record<string, number | Error> = {}) {
  const calls: { url: string; userAgent: string | null }[] = [];
  let gates = 0;
  const deps: LookupDeps = {
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, userAgent: new Headers(init?.headers).get('User-Agent') });
      const override = overrides[url];
      if (override instanceof Error) throw override;
      const [status, name] = RECORDED[url] ?? [404, 'musicbrainz-isrc-missing'];
      return new Response(fixture(name), { status: override ?? status });
    },
    musicBrainzGate: async () => {
      gates += 1;
    },
  };
  return { deps, calls, gates: () => gates };
}

const tenant = (workspaceRole: string) => ({ workspaceRole }) as TenantContext;

describe('lookupIsrc (IMP-016)', () => {
  it('suggests details from both sources for a known ISRC, in any spelling', async () => {
    const { deps, calls, gates } = recorded();
    const result = await lookupIsrc(tenant('member'), { isrc: 'gb-duw-00-00059' }, deps);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.isrc).toBe(FOUND);
    expect(result.value.sources).toEqual({ musicbrainz: 'found', deezer: 'found' });
    const pick = (source: string, field: string) =>
      result.value.suggestions
        .filter((s) => s.source === source && s.field === field)
        .map((s) => s.value);
    expect(pick('deezer', 'title')).toEqual(['Harder, Better, Faster, Stronger']);
    expect(pick('deezer', 'primaryArtistNames')).toEqual([['Daft Punk']]);
    expect(pick('deezer', 'durationMs')).toEqual([226000]);
    expect(pick('deezer', 'releaseTitle')).toEqual(['Discovery']);
    expect(pick('deezer', 'releaseDate')).toEqual(['2001-03-07']);
    expect(pick('deezer', 'upc')).toEqual(['724384960650']);
    expect(pick('deezer', 'label')).toEqual(['Daft Life Ltd./ADA France']);
    expect(pick('musicbrainz', 'durationMs')).toEqual([224293]);
    expect(pick('musicbrainz', 'iswc')).toEqual(['T0714951662']);
    const codes = result.value.suggestions.filter((s) => s.field === 'proWorkCode');
    expect(codes).toContainEqual({
      field: 'proWorkCode',
      value: '5571794',
      societyCode: 'BMI',
      source: 'musicbrainz',
      sourceUrl: `https://musicbrainz.org/work/${WORK}`,
    });
    expect(codes.map((c) => c.societyCode)).toContain('ASCAP');
    expect(gates()).toBe(2);
    expect(calls.every((c) => c.userAgent === USER_AGENT)).toBe(true);
  });

  it('reports an unknown ISRC as not found on both sources', async () => {
    const { deps } = recorded();
    const result = await lookupIsrc(tenant('member'), { isrc: MISSING }, deps);
    expect(result).toEqual({
      ok: true,
      value: {
        isrc: MISSING,
        sources: { musicbrainz: 'not_found', deezer: 'not_found' },
        suggestions: [],
      },
    });
  });

  it('keeps the other source when one fails or is busy', async () => {
    const { deps } = recorded({
      [`https://musicbrainz.org/ws/2/isrc/${FOUND}?fmt=json&inc=artist-credits+work-rels`]: 503,
      'https://api.deezer.com/album/302127': new Error('socket hang up'),
    });
    const result = await lookupIsrc(tenant('member'), { isrc: FOUND }, deps);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.sources).toEqual({ musicbrainz: 'unavailable', deezer: 'found' });
    expect(result.value.suggestions.every((s) => s.source === 'deezer')).toBe(true);
    // Without the album, the release comes from the track's own album summary, which has no UPC.
    expect(result.value.suggestions.find((s) => s.field === 'upc')).toBeUndefined();
    expect(result.value.suggestions.find((s) => s.field === 'releaseTitle')?.value).toBe(
      'Discovery',
    );
  });

  it('refuses a malformed ISRC before calling anyone, and a role without catalog read', async () => {
    const { deps, calls } = recorded();
    expect(await lookupIsrc(tenant('member'), { isrc: 'not-an-isrc' }, deps)).toEqual({
      ok: false,
      error: { code: 'INVALID_ISRC', field: 'isrc', reason: 'shape' },
    });
    expect(await lookupIsrc(tenant('nobody'), { isrc: FOUND }, deps)).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(calls).toEqual([]);
  });
});

describe('minimumGap (MusicBrainz rate limit)', () => {
  it('spaces calls at least the gap apart, in call order', async () => {
    let clock = 0;
    const waits: number[] = [];
    const gate = minimumGap(
      1100,
      () => clock,
      async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    );
    const passed: number[] = [];
    await Promise.all([1, 2, 3].map((n) => gate().then(() => passed.push(n))));
    expect(passed).toEqual([1, 2, 3]);
    expect(waits).toEqual([1100, 1100]);
    clock += 5000;
    await gate();
    expect(waits).toEqual([1100, 1100]);
  });
});
