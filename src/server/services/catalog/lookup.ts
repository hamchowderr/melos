import type {
  IsrcLookupDTO,
  LookupSource,
  LookupSourceStatus,
  LookupSuggestion,
} from '../../../lib/dto/lookup';
import { normalizeIsrc, normalizeIswc, normalizeUpcEan } from '../../../lib/identifiers';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';

/**
 * CatalogLookupService (docs/CONTRACT.md §2.4, IMP-016, U-33): asks MusicBrainz and Deezer about one
 * ISRC and returns what they know as suggestions. It writes nothing; an accepted suggestion goes
 * through the normal catalog services and audit. Spotify is not used.
 */

/** MusicBrainz asks for a User-Agent naming the application and a contact. */
export const USER_AGENT = 'Melos/0.1 ( https://github.com/hamchowderr/melos )';
const MUSICBRAINZ = 'https://musicbrainz.org';
const DEEZER = 'https://api.deezer.com';
const TIMEOUT_MS = 8000;

/**
 * A gate that spaces calls at least `gapMs` apart, in call order. MusicBrainz allows about one request
 * per second per client; the gate holds per server instance, which is the client MusicBrainz sees.
 */
export function minimumGap(
  gapMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): () => Promise<void> {
  let next = 0;
  let queue = Promise.resolve();
  return () => {
    queue = queue.then(async () => {
      const wait = next - now();
      if (wait > 0) await sleep(wait);
      next = now() + gapMs;
    });
    return queue;
  };
}

export type LookupDeps = { fetch: typeof fetch; musicBrainzGate: () => Promise<void> };

const defaultDeps: LookupDeps = {
  fetch: (...args) => fetch(...args),
  musicBrainzGate: minimumGap(1100),
};

type Json = Record<string, unknown>;
type Answer = { status: 'found'; body: Json } | { status: 'not_found' | 'unavailable' };

/** One GET. A 404, or Deezer's `DataException` (code 800) in a 200 body, means the source has no such item. */
async function getJson(deps: LookupDeps, url: string): Promise<Answer> {
  try {
    const response = await deps.fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return { status: 'not_found' };
    if (!response.ok) return { status: 'unavailable' };
    const body = (await response.json()) as Json;
    const error = body.error as { code?: number } | undefined;
    if (error) return { status: error.code === 800 ? 'not_found' : 'unavailable' };
    return { status: 'found', body };
  } catch {
    return { status: 'unavailable' };
  }
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** A suggestion before its source is set; the conditional keeps Omit from merging the union. */
type Unsourced = LookupSuggestion extends infer S
  ? S extends LookupSuggestion
    ? Omit<S, 'source'>
    : never
  : never;
type Suggest = (suggestion: Unsourced) => void;

/** Deezer's track, and its album when fetched: title, artists, duration, release, UPC and label. */
export function deezerSuggestions(track: Json, album: Json | null): LookupSuggestion[] {
  const out: LookupSuggestion[] = [];
  const add: Suggest = (s) => out.push({ ...s, source: 'deezer' } as LookupSuggestion);
  const trackUrl = text(track.link) ?? `https://www.deezer.com/track/${track.id}`;
  const title = text(track.title);
  if (title) add({ field: 'title', value: title, sourceUrl: trackUrl });
  const contributors = (track.contributors as { name?: string; role?: string }[] | undefined) ?? [];
  const main = contributors.filter((c) => c.role === 'Main').map((c) => text(c.name));
  const artists = (main.length ? main : [text((track.artist as Json | undefined)?.name)]).filter(
    (name): name is string => !!name,
  );
  if (artists.length) add({ field: 'primaryArtistNames', value: artists, sourceUrl: trackUrl });
  if (typeof track.duration === 'number' && track.duration > 0)
    add({ field: 'durationMs', value: track.duration * 1000, sourceUrl: trackUrl });
  const release = album ?? (track.album as Json | undefined) ?? {};
  const releaseUrl = text(release.link) ?? trackUrl;
  const releaseTitle = text(release.title);
  if (releaseTitle) add({ field: 'releaseTitle', value: releaseTitle, sourceUrl: releaseUrl });
  const releaseDate = text(release.release_date) ?? text(track.release_date);
  if (releaseDate) add({ field: 'releaseDate', value: releaseDate, sourceUrl: releaseUrl });
  const upc = normalizeUpcEan(String(release.upc ?? ''));
  if (upc.ok) add({ field: 'upc', value: upc.value, sourceUrl: releaseUrl });
  const label = text(release.label);
  if (label) add({ field: 'label', value: label, sourceUrl: releaseUrl });
  return out;
}

/** The first MusicBrainz recording for the ISRC, and its work when fetched: ISWC and PRO work IDs. */
export function musicBrainzSuggestions(recording: Json, work: Json | null): LookupSuggestion[] {
  const out: LookupSuggestion[] = [];
  const add: Suggest = (s) => out.push({ ...s, source: 'musicbrainz' } as LookupSuggestion);
  const recordingUrl = `${MUSICBRAINZ}/recording/${recording.id}`;
  const title = text(recording.title);
  if (title) add({ field: 'title', value: title, sourceUrl: recordingUrl });
  const credits = (recording['artist-credit'] as { name?: string }[] | undefined) ?? [];
  const artists = credits.map((c) => text(c.name)).filter((name): name is string => !!name);
  if (artists.length) add({ field: 'primaryArtistNames', value: artists, sourceUrl: recordingUrl });
  if (typeof recording.length === 'number' && recording.length > 0)
    add({ field: 'durationMs', value: recording.length, sourceUrl: recordingUrl });
  const related = performedWork(recording);
  const source = work ?? related;
  if (!source) return out;
  const workUrl = `${MUSICBRAINZ}/work/${source.id}`;
  for (const iswc of (source.iswcs as string[] | undefined) ?? []) {
    const normalized = normalizeIswc(iswc);
    if (normalized.ok) add({ field: 'iswc', value: normalized.value, sourceUrl: workUrl });
  }
  for (const attribute of (work?.attributes as { type?: string; value?: string }[]) ?? []) {
    const society = /^(.+) ID$/.exec(attribute.type ?? '')?.[1];
    const code = text(attribute.value);
    if (society && code)
      add({
        field: 'proWorkCode',
        value: code,
        societyCode: society.toUpperCase(),
        sourceUrl: workUrl,
      });
  }
  return out;
}

function performedWork(recording: Json): Json | null {
  const relations = (recording.relations as { type?: string; work?: Json }[] | undefined) ?? [];
  return relations.find((r) => r.type === 'performance' && r.work)?.work ?? null;
}

async function fromDeezer(deps: LookupDeps, isrc: string) {
  const track = await getJson(deps, `${DEEZER}/track/isrc:${isrc}`);
  if (track.status !== 'found') return { status: track.status, suggestions: [] };
  const albumId = (track.body.album as Json | undefined)?.id;
  const album = albumId ? await getJson(deps, `${DEEZER}/album/${albumId}`) : null;
  const albumBody = album?.status === 'found' ? album.body : null;
  return { status: 'found' as const, suggestions: deezerSuggestions(track.body, albumBody) };
}

async function fromMusicBrainz(deps: LookupDeps, isrc: string) {
  await deps.musicBrainzGate();
  const found = await getJson(
    deps,
    `${MUSICBRAINZ}/ws/2/isrc/${isrc}?fmt=json&inc=artist-credits+work-rels`,
  );
  if (found.status !== 'found') return { status: found.status, suggestions: [] };
  const recording = ((found.body.recordings as Json[] | undefined) ?? [])[0];
  if (!recording) return { status: 'not_found' as const, suggestions: [] };
  const related = performedWork(recording);
  let work: Json | null = null;
  if (related?.id) {
    await deps.musicBrainzGate();
    const answer = await getJson(deps, `${MUSICBRAINZ}/ws/2/work/${related.id}?fmt=json`);
    if (answer.status === 'found') work = answer.body;
  }
  return { status: 'found' as const, suggestions: musicBrainzSuggestions(recording, work) };
}

/** Looks one ISRC up on both sources at once. A source that fails is `unavailable`, never an error. */
export async function lookupIsrc(
  tenant: TenantContext,
  input: { isrc: string },
  deps: LookupDeps = defaultDeps,
): Promise<ServiceResult<IsrcLookupDTO>> {
  if (!requirePermission(tenant, { catalog: ['read'] }).ok) return failure('FORBIDDEN');
  const isrc = normalizeIsrc(input.isrc);
  if (!isrc.ok) return failure({ code: 'INVALID_ISRC', field: 'isrc', reason: isrc.error.reason });
  const [musicbrainz, deezer] = await Promise.all([
    fromMusicBrainz(deps, isrc.value),
    fromDeezer(deps, isrc.value),
  ]);
  const sources: Record<LookupSource, LookupSourceStatus> = {
    musicbrainz: musicbrainz.status,
    deezer: deezer.status,
  };
  return success({
    isrc: isrc.value,
    sources,
    suggestions: [...musicbrainz.suggestions, ...deezer.suggestions],
  });
}
